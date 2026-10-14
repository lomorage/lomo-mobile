import 'react-native-gesture-handler/jestSetup';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

// Every screen is a stub showing its name. The Login stub goes straight to Register, the way
// the setup link (QR code) does.
jest.mock('../../screens/LoginScreen', () => function LoginStub() {
  const React = require('react');
  const { Text } = require('react-native');
  const navigation = require('@react-navigation/native').useNavigation();
  React.useEffect(() => { navigation.navigate('Register'); }, []);
  return React.createElement(Text, null, 'screen:Login');
});
jest.mock('../../screens/RegisterScreen', () => () => require('react').createElement(require('react-native').Text, null, 'screen:Register'));
jest.mock('../../screens/HomeScreen', () => () => require('react').createElement(require('react-native').Text, null, 'screen:Home'));
jest.mock('../../screens/AssetDetailScreen', () => () => null);
jest.mock('../../screens/ScanLoginScreen', () => () => null);
jest.mock('../../screens/ShowSignInCodeScreen', () => () => null);
jest.mock('../../screens/SettingsScreen', () => () => null);
jest.mock('../../screens/FreeUpSpaceScreen', () => () => null);
jest.mock('../../screens/BackupSummaryScreen', () => () => null);
jest.mock('../../screens/PhotoMapScreen', () => () => null);
jest.mock('../../screens/AlbumsScreen', () => () => null);
jest.mock('../../screens/FolderDetailScreen', () => () => null);
jest.mock('../../screens/AlbumDetailScreen', () => () => null);
jest.mock('../../screens/DuplicatesScreen', () => () => null);
jest.mock('lucide-react-native', () => ({ Image: () => null, Folder: () => null }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}) }));
jest.mock('../../services/AuthService', () => ({ __esModule: true, default: {} }));
jest.mock('../../context/SettingsContext', () => ({ SettingsProvider: ({ children }) => children }));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => React.createElement(View, null, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: React.createContext(insets),
    SafeAreaFrameContext: React.createContext(frame),
  };
});

// Sign-in state the test flips, like AuthContext.register does after a successful sign-up.
let mockSetAuthenticated;
jest.mock('../../context/AuthContext', () => {
  const React = require('react');
  return {
    AuthProvider: ({ children }) => children,
    useAuth: () => {
      const [isAuthenticated, setAuthenticated] = React.useState(false);
      mockSetAuthenticated = setAuthenticated;
      return { isAuthenticated, isLoading: false };
    },
  };
});

import RootNavigator from '../RootNavigator';


const visibleScreens = (tree) => tree.root.findAllByType(Text)
  .map(t => t.props.children)
  .filter(c => typeof c === 'string' && c.startsWith('screen:'));

test('signing up on the Register screen takes the user into the app', async () => {
  // Card transitions run on timers; keep them inside the test so none fire after teardown.
  jest.useFakeTimers();
  let tree;
  await act(async () => { tree = renderer.create(<RootNavigator />); });
  await act(async () => { jest.runAllTimers(); });
  expect(visibleScreens(tree)).toContain('screen:Register');

  await act(async () => { mockSetAuthenticated(true); });
  await act(async () => { jest.runAllTimers(); });

  expect(visibleScreens(tree)).not.toContain('screen:Register');
  expect(visibleScreens(tree)).toContain('screen:Home');

  await act(async () => { jest.runAllTimers(); });
  await act(async () => { tree.unmount(); });
  await act(async () => { jest.runAllTimers(); });
  jest.useRealTimers();
});

