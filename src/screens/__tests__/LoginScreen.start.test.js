import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { Eye: Icon, EyeOff: Icon, QrCode: Icon, ArrowLeft: Icon };
});
jest.mock('../../services/AuthService', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/DiscoveryService', () => ({
  __esModule: true,
  default: { onDiscovered: jest.fn(() => jest.fn()), scan: jest.fn(() => new Promise(() => {})) },
}));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ login: jest.fn() }) }));
jest.mock('../RegisterScreen', () => ({ getRegisterDraft: () => ({ server: '10.0.0.219:8000', username: '' }) }));

import LoginScreen from '../LoginScreen';

const navigation = { navigate: jest.fn() };
const press = (tree, label) => {
  const b = tree.root.findAllByType(TouchableOpacity).find(t => t.findAllByType(Text).some(x => x.props.children === label));
  if (!b) throw new Error(`No button "${label}"`);
  return act(async () => { b.props.onPress(); });
};
const render = async () => {
  let tree;
  await act(async () => { tree = renderer.create(<LoginScreen navigation={navigation} />); });
  return tree;
};

beforeEach(() => jest.clearAllMocks());

test('the first screen leads with setting up, which goes straight to Create Account', async () => {
  const tree = await render();
  await press(tree, 'Set up Lomorage');
  expect(navigation.navigate).toHaveBeenCalledWith('Register');
});

test('joining with a code and signing in are offered as "already set up"', async () => {
  const tree = await render();
  await press(tree, 'Scan a sign-in code from your family');
  expect(navigation.navigate).toHaveBeenCalledWith('ScanLogin');
});

test('manual sign-in reuses the address already entered on Create Account', async () => {
  const tree = await render();
  await press(tree, 'Sign in with username and password');
  const server = tree.root.findAll(n => n.props && n.props.placeholder === 'e.g., 192.168.1.100:8000')[0];
  expect(server.props.value).toBe('10.0.0.219:8000');
});
