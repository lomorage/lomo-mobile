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

import RegisterScreen from '../RegisterScreen';

const nav = { navigate: jest.fn(), goBack: jest.fn() };
const mount = async () => {
  let r;
  await act(async () => {
    r = renderer.create(<RegisterScreen navigation={nav} route={{ params: { server: '10.0.0.219:8000' } }} />);
  });
  return r;
};
const input = (r, placeholder) => r.root.findAllByType(TextInput).find((i) => i.props.placeholder === placeholder);

test('pressing Back and coming back keeps the username but never the passwords', async () => {
  let r = await mount();
  await act(async () => {
    input(r, 'Choose a username').props.onChangeText('sarah');
    input(r, 'Min 6 characters').props.onChangeText('secret1');
  });
  await act(async () => r.unmount());

  r = await mount();
  expect(input(r, 'Choose a username').props.value).toBe('sarah');
  expect(input(r, 'Min 6 characters').props.value).toBe('');
  await act(async () => r.unmount());
});
