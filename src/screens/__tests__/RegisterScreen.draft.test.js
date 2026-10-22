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
  default: { getAvailableDisks: jest.fn().mockResolvedValue([]) },
}));

import RegisterScreen, { resetRegisterDraft } from '../RegisterScreen';

beforeEach(() => resetRegisterDraft());
const nav = { navigate: jest.fn(), goBack: jest.fn() };
const mount = async (params = {}) => {
  let r;
  await act(async () => {
    r = renderer.create(<RegisterScreen navigation={nav} route={{ params }} />);
  });
  return r;
};
const input = (r, placeholder) => r.root.findAllByType(TextInput).find((i) => i.props.placeholder === placeholder);

test('pressing Back and coming back keeps the username but never the passwords', async () => {
  let r = await mount({ server: '10.0.0.219:8000' });
  await act(async () => {
    input(r, 'Choose a username').props.onChangeText('sarah');
    input(r, 'Min 6 characters').props.onChangeText('secret1');
  });
  await act(async () => r.unmount());

  r = await mount();
  expect(input(r, 'e.g., 192.168.1.100:8000').props.value).toBe('10.0.0.219:8000');
  expect(input(r, 'Choose a username').props.value).toBe('sarah');
  expect(input(r, 'Min 6 characters').props.value).toBe('');
  await act(async () => r.unmount());
});

test('adding a family member from Settings starts from a blank form', async () => {
  let r = await mount({ server: '10.0.0.219:8000' });
  await act(async () => { input(r, 'Choose a username').props.onChangeText('sarah'); });
  await act(async () => r.unmount());

  r = await mount({ fromSettings: true });
  expect(input(r, 'Choose a username').props.value).toBe('');
  await act(async () => r.unmount());
});

test('a half-typed address is restored but not looked up', async () => {
  const AuthService = require('../../services/AuthService').default;
  let r = await mount();
  await act(async () => { input(r, 'e.g., 192.168.1.100:8000').props.onChangeText('10.0.'); });
  await act(async () => r.unmount());
  AuthService.getAvailableDisks.mockClear();

  r = await mount();
  expect(input(r, 'e.g., 192.168.1.100:8000').props.value).toBe('10.0.');
  expect(AuthService.getAvailableDisks).not.toHaveBeenCalled();
  await act(async () => r.unmount());
});
