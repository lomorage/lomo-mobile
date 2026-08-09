import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('../../services/AuthService', () => ({
  init: jest.fn(),
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  setOnSessionExpired: jest.fn(),
}));

const AuthService = require('../../services/AuthService');
import { AuthProvider, useAuth } from '../AuthContext';

let latestAuth;
function Consumer() {
  latestAuth = useAuth();
  return null;
}

async function renderAuthProvider() {
  let root;
  await act(async () => {
    root = renderer.create(<AuthProvider><Consumer /></AuthProvider>);
  });
  return root;
}

beforeEach(() => {
  jest.clearAllMocks();
  AuthService.init.mockResolvedValue(false);
  AuthService.login.mockResolvedValue();
  AuthService.register.mockResolvedValue();
  AuthService.logout.mockResolvedValue();
  latestAuth = undefined;
});

describe('initial auth check', () => {
  test('isAuthenticated becomes true and isLoading false after AuthService.init() resolves true', async () => {
    AuthService.init.mockResolvedValue(true);
    await renderAuthProvider();
    expect(latestAuth.isAuthenticated).toBe(true);
    expect(latestAuth.isLoading).toBe(false);
  });

  test('isAuthenticated stays false and isLoading becomes false after AuthService.init() resolves false', async () => {
    AuthService.init.mockResolvedValue(false);
    await renderAuthProvider();
    expect(latestAuth.isAuthenticated).toBe(false);
    expect(latestAuth.isLoading).toBe(false);
  });

  test('a thrown init() error still clears isLoading instead of hanging forever', async () => {
    AuthService.init.mockRejectedValue(new Error('secure store unavailable'));
    await renderAuthProvider();
    expect(latestAuth.isLoading).toBe(false);
    expect(latestAuth.isAuthenticated).toBe(false);
  });
});

describe('login / register / logout', () => {
  test('login() sets isAuthenticated true after AuthService.login succeeds', async () => {
    await renderAuthProvider();
    await act(async () => {
      await latestAuth.login('http://server', 'user', 'pass');
    });
    expect(AuthService.login).toHaveBeenCalledWith('http://server', 'user', 'pass', null);
    expect(latestAuth.isAuthenticated).toBe(true);
  });

  test('login() does not set isAuthenticated when AuthService.login throws', async () => {
    AuthService.login.mockRejectedValue(new Error('bad credentials'));
    await renderAuthProvider();
    await act(async () => {
      await expect(latestAuth.login('http://server', 'user', 'wrong')).rejects.toThrow('bad credentials');
    });
    expect(latestAuth.isAuthenticated).toBe(false);
  });

  test('register() with autoLogin=true (the default) sets isAuthenticated true', async () => {
    await renderAuthProvider();
    await act(async () => {
      await latestAuth.register('http://server', 'user', 'pass', '/home/user');
    });
    expect(latestAuth.isAuthenticated).toBe(true);
  });

  test('register() with autoLogin=false leaves isAuthenticated false', async () => {
    await renderAuthProvider();
    await act(async () => {
      await latestAuth.register('http://server', 'user', 'pass', '/home/user', false);
    });
    expect(latestAuth.isAuthenticated).toBe(false);
  });

  test('logout() calls AuthService.logout and clears isAuthenticated', async () => {
    AuthService.init.mockResolvedValue(true);
    await renderAuthProvider();
    expect(latestAuth.isAuthenticated).toBe(true);

    await act(async () => {
      await latestAuth.logout();
    });
    expect(AuthService.logout).toHaveBeenCalled();
    expect(latestAuth.isAuthenticated).toBe(false);
  });
});

describe('session-expiry handling', () => {
  test('registers an onSessionExpired callback on mount', async () => {
    await renderAuthProvider();
    expect(AuthService.setOnSessionExpired).toHaveBeenCalledWith(expect.any(Function));
  });

  test('invoking the registered callback logs out and clears isAuthenticated', async () => {
    AuthService.init.mockResolvedValue(true);
    await renderAuthProvider();
    expect(latestAuth.isAuthenticated).toBe(true);

    const onSessionExpired = AuthService.setOnSessionExpired.mock.calls[0][0];
    await act(async () => {
      await onSessionExpired();
    });

    expect(AuthService.logout).toHaveBeenCalled();
    expect(latestAuth.isAuthenticated).toBe(false);
  });

  test('unregisters the callback (passes null) on unmount', async () => {
    const root = await renderAuthProvider();
    await act(async () => {
      root.unmount();
    });
    expect(AuthService.setOnSessionExpired).toHaveBeenLastCalledWith(null);
  });
});
