import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { Eye: Icon, EyeOff: Icon, ArrowLeft: Icon, HardDrive: Icon, CheckCircle: Icon, QrCode: Icon };
});
jest.mock('../../components/PairingQRModal', () => () => null);
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ register: jest.fn() }) }));
jest.mock('../../services/DiscoveryService', () => ({
  __esModule: true,
  default: { onDiscovered: jest.fn(() => jest.fn()), scan: jest.fn(() => new Promise(() => {})) },
}));
jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: { getAvailableDisks: jest.fn() },
}));

import AuthService from '../../services/AuthService';
import RegisterScreen, { SERVER_LOOKUP_DEBOUNCE_MS } from '../RegisterScreen';

const DISK = { name: 'media', freeSize: 6000, totalSize: 464000 };

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root;
async function render(params = {}) {
  await act(async () => {
    root = renderer.create(
      <RegisterScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} route={{ params }} />
    );
  });
}
const serverInput = () =>
  root.root.findAllByType(TextInput).find((i) => i.props.placeholder?.startsWith('e.g.'));
const typeServer = (text) =>
  act(async () => {
    serverInput().props.onChangeText(text);
  });
// Types a value one character at a time, the way a keyboard does.
async function typeSlowly(text) {
  for (let i = 1; i <= text.length; i += 1) await typeServer(text.slice(0, i));
}
const advance = (ms) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });
const screenText = () => JSON.stringify(root.toJSON());

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  AuthService.getAvailableDisks.mockResolvedValue([DISK]);
});
afterEach(() => {
  act(() => root.unmount());
  jest.useRealTimers();
});

describe('RegisterScreen server address lookup', () => {
  test('typing an address does not contact the server on every keystroke', async () => {
    await render();
    await typeSlowly('10.0.0.219:8000');
    expect(AuthService.getAvailableDisks).not.toHaveBeenCalled();
  });

  test('looks up once, with the full address, after the user pauses', async () => {
    await render();
    await typeSlowly('10.0.0.219:8000');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);

    expect(AuthService.getAvailableDisks).toHaveBeenCalledTimes(1);
    expect(AuthService.getAvailableDisks).toHaveBeenCalledWith(
      '10.0.0.219:8000',
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  test('keeps waiting while the user is still typing', async () => {
    await render();
    await typeServer('10.0.0.219:80');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS - 100);
    await typeServer('10.0.0.219:800');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS - 100);
    expect(AuthService.getAvailableDisks).not.toHaveBeenCalled();
    await typeServer('10.0.0.219:8000');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);
    expect(AuthService.getAvailableDisks).toHaveBeenCalledTimes(1);
  });

  test('never looks up an incomplete address', async () => {
    await render();
    await typeServer('10.0.0.219:');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS * 3);
    expect(AuthService.getAvailableDisks).not.toHaveBeenCalled();
  });

  test('a lookup still running when the text changes is cancelled and its result ignored', async () => {
    const first = deferred();
    AuthService.getAvailableDisks.mockReturnValueOnce(first.promise);
    await render();

    await typeServer('10.0.0.219:80');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);
    const { signal } = AuthService.getAvailableDisks.mock.calls[0][1];
    expect(signal.aborted).toBe(false);

    await typeServer('10.0.0.219:8000'); // edited while the first lookup is in flight
    expect(signal.aborted).toBe(true);

    await act(async () => {
      first.resolve([{ name: 'stale-disk', freeSize: 1, totalSize: 1 }]);
    });
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);
    await act(async () => {});

    // The stale disk never shows up; the lookup for the final text did.
    expect(screenText()).not.toContain('stale-disk');
    expect(screenText()).toContain('media');
  });

  test('disks from the previous address are cleared when the address is edited', async () => {
    await render();
    await typeServer('10.0.0.219:8000');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);
    await act(async () => {});
    expect(screenText()).toContain('media');

    await typeServer('10.0.0.219:800');
    expect(screenText()).not.toContain('media');
  });

  test('a failed lookup is quiet and leaves the form usable', async () => {
    AuthService.getAvailableDisks.mockRejectedValueOnce(new Error('Could not connect'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await render();
    await typeServer('10.0.0.219:8000');
    await advance(SERVER_LOOKUP_DEBOUNCE_MS);
    await act(async () => {});
    expect(serverInput().props.value).toBe('10.0.0.219:8000');
    spy.mockRestore();
  });

  test('a server handed over by the setup QR is looked up immediately, without waiting', async () => {
    await render({ server: '10.0.0.219:8000' });
    await act(async () => {});
    expect(AuthService.getAvailableDisks).toHaveBeenCalledTimes(1);
    expect(AuthService.getAvailableDisks.mock.calls[0][0]).toBe('10.0.0.219:8000');
  });

  test('leaving the screen cancels a pending lookup', async () => {
    await render();
    await typeServer('10.0.0.219:8000');
    act(() => root.unmount());
    await advance(SERVER_LOOKUP_DEBOUNCE_MS * 2);
    expect(AuthService.getAvailableDisks).not.toHaveBeenCalled();
    root = { unmount: () => {} }; // afterEach unmounts again; make that a no-op
  });
});
