import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('../../services/AuthService', () => ({
  init: jest.fn(),
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  setOnSessionExpired: jest.fn(),
}));

jest.mock('../../services/FirstBackupService', () => ({
  __esModule: true,
  default: {
    beginIfNeeded: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../../utils/scaleMetrics', () => ({ markPaired: jest.fn() }));
jest.mock('../../services/backupHistory', () => ({ clearLastBackupAt: jest.fn() }));

const AuthService = require('../../services/AuthService');
const { markPaired } = require('../../utils/scaleMetrics');
const { clearLastBackupAt } = require('../../services/backupHistory');
const FirstBackupService = require('../../services/FirstBackupService').default;
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
  markPaired.mockResolvedValue(false);
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
    expect(FirstBackupService.beginIfNeeded).toHaveBeenCalledTimes(1);
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
    expect(FirstBackupService.beginIfNeeded).toHaveBeenCalledTimes(1);
    expect(latestAuth.isAuthenticated).toBe(true);
  });

  test('register() with autoLogin=false leaves isAuthenticated false', async () => {
    await renderAuthProvider();
    await act(async () => {
      await latestAuth.register('http://server', 'user', 'pass', '/home/user', false);
    });
    expect(FirstBackupService.beginIfNeeded).not.toHaveBeenCalled();
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

describe('pairing with a computer', () => {
  test('a new computer or account forgets the previous last-backup time', async () => {
    markPaired.mockResolvedValue(true);
    await renderAuthProvider();
    await act(async () => { await latestAuth.login('nas:8000', 'alice', 'pw'); });
    expect(markPaired).toHaveBeenCalledWith('nas:8000|alice');
    expect(clearLastBackupAt).toHaveBeenCalled();
  });

  test('signing in again to the same one keeps it', async () => {
    markPaired.mockResolvedValue(false);
    await renderAuthProvider();
    await act(async () => { await latestAuth.login('nas:8000', 'alice', 'pw'); });
    expect(clearLastBackupAt).not.toHaveBeenCalled();
  });

  test('sign-up passes the computer name from the setup link on to login', async () => {
    await renderAuthProvider();
    await act(async () => { await latestAuth.register('nas:8000', 'alice', 'pw', 'disk', true, 'windows'); });
    expect(AuthService.register).toHaveBeenCalledWith('nas:8000', 'alice', 'pw', 'disk', '', true, 'windows');
  });
});
