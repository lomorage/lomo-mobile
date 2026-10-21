import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text, TextInput, TouchableOpacity } from 'react-native';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { Eye: Icon, EyeOff: Icon, ArrowLeft: Icon, HardDrive: Icon, CheckCircle: Icon, QrCode: Icon };
});
jest.mock('../../components/PairingQRModal', () => () => null);
const mockRegister = jest.fn();
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ register: mockRegister }) }));
jest.mock('../../services/DiscoveryService', () => ({
  __esModule: true,
  default: { onDiscovered: jest.fn(() => jest.fn()), scan: jest.fn(() => new Promise(() => {})) },
}));
jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: { getAvailableDisks: jest.fn().mockResolvedValue([{ name: 'media', freeSize: 6000, totalSize: 464000 }]) },
}));

import RegisterScreen from '../RegisterScreen';

let root;
async function fillAndSubmit(params) {
  await act(async () => {
    root = renderer.create(
      <RegisterScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} route={{ params }} />
    );
  });
  const input = (placeholder) => root.root.findAllByType(TextInput).find((i) => i.props.placeholder === placeholder);
  await act(async () => {
    input('Choose a username').props.onChangeText('alice');
    input('Min 6 characters').props.onChangeText('secret1');
    input('Repeat password').props.onChangeText('secret1');
  });
  const submit = root.root.findAllByType(TouchableOpacity).find((b) => JSON.stringify(b.findAllByType(Text).map((t) => t.props.children)).includes('Register'));
  await act(async () => {
    await submit.props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => act(() => root.unmount()));

test('a first-time setup tells the new user the account was created and what comes next', async () => {
  mockRegister.mockResolvedValue(undefined);
  await fillAndSubmit({ server: '10.0.0.219:8000' });
  expect(Alert.alert).toHaveBeenCalledWith('Account created', expect.stringContaining('alice'));
});

test('no "created" message when registration fails', async () => {
  mockRegister.mockRejectedValue(new Error('boom'));
  await fillAndSubmit({ server: '10.0.0.219:8000' });
  expect(Alert.alert).not.toHaveBeenCalledWith('Account created', expect.anything());
  expect(Alert.alert).toHaveBeenCalledWith('Registration Failed', 'boom');
});

test('adding a family member from Settings keeps its own QR hand-over, not this message', async () => {
  mockRegister.mockResolvedValue(undefined);
  await fillAndSubmit({ server: '10.0.0.219:8000', fromSettings: true });
  expect(Alert.alert).not.toHaveBeenCalledWith('Account created', expect.anything());
});
