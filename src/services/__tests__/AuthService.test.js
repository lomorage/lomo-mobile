jest.mock('react-native-argon2', () => jest.fn());
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import AuthService, { formatServerUrl, tokenOfRequest } from '../AuthService';

describe('formatServerUrl', () => {
  test('formats localhost correctly to http', () => {
    expect(formatServerUrl('localhost')).toBe('http://localhost');
    expect(formatServerUrl('localhost:8000')).toBe('http://localhost:8000');
  });

  test('formats local .local domain correctly to http', () => {
    expect(formatServerUrl('raspberrypi.local')).toBe('http://raspberrypi.local');
    expect(formatServerUrl('raspberrypi.local:8000')).toBe('http://raspberrypi.local:8000');
  });

  test('formats IPv4 addresses correctly to http', () => {
    expect(formatServerUrl('192.168.1.100')).toBe('http://192.168.1.100');
    expect(formatServerUrl('192.168.1.100:8000')).toBe('http://192.168.1.100:8000');
  });

  test('formats domain name with custom port to http', () => {
    expect(formatServerUrl('lomo.aalomo.net:8002')).toBe('http://lomo.aalomo.net:8002');
    expect(formatServerUrl('lomo.aalomo.net:8000')).toBe('http://lomo.aalomo.net:8000');
  });

  test('formats domain name with port 443 to https', () => {
    expect(formatServerUrl('lomo.aalomo.net:443')).toBe('https://lomo.aalomo.net:443');
  });

  test('formats domain name without port to https', () => {
    expect(formatServerUrl('lomo.aalomo.net')).toBe('https://lomo.aalomo.net');
  });

  test('preserves already prefixed URLs', () => {
    expect(formatServerUrl('http://lomo.aalomo.net:8002')).toBe('http://lomo.aalomo.net:8002');
    expect(formatServerUrl('https://lomo.aalomo.net:8002')).toBe('https://lomo.aalomo.net:8002');
    expect(formatServerUrl('http://192.168.1.100:8000')).toBe('http://192.168.1.100:8000');
  });

  test('returns falsy inputs untouched', () => {
    expect(formatServerUrl('')).toBe('');
    expect(formatServerUrl(null)).toBeNull();
    expect(formatServerUrl(undefined)).toBeUndefined();
  });
});

describe('preview codec from /system', () => {
  beforeEach(() => {
    AuthService.webpPreview = false;
    jest.clearAllMocks();
  });

  test('turns WebP previews on and persists it when the server reports WebpPreview', async () => {
    await AuthService.applySystemInfo({ WebpPreview: true, APIVersion: '1.1' });
    expect(AuthService.supportsWebpPreview()).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomo_webp_preview', '1');
  });

  test('falls back to JPEG for a server started with --use-jpg', async () => {
    AuthService.webpPreview = true;
    await AuthService.applySystemInfo({ WebpPreview: false });
    expect(AuthService.supportsWebpPreview()).toBe(false);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomo_webp_preview', '0');
  });

  test('treats a server without the field as JPEG-only', async () => {
    await AuthService.applySystemInfo({ APIVersion: '1.0' });
    expect(AuthService.supportsWebpPreview()).toBe(false);
  });

  test('ignores a missing or unparsable /system body', async () => {
    AuthService.webpPreview = true;
    await AuthService.applySystemInfo(null);
    expect(AuthService.supportsWebpPreview()).toBe(true);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('restores the saved codec on init', async () => {
    SecureStore.getItemAsync.mockImplementation(async (key) => (key === 'lomo_webp_preview' ? '1' : null));
    await AuthService.init();
    expect(AuthService.supportsWebpPreview()).toBe(true);
  });
});

describe('getAvailableDisks', () => {
  afterEach(() => jest.restoreAllMocks());

  test('is a quick, cancellable probe that never triggers the connection-lost failover', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: [{ Dir: 'media', FreeSize: 6000, TotalSize: 464000 }],
    });
    const controller = new AbortController();

    const disks = await AuthService.getAvailableDisks('10.0.0.219:8000', { signal: controller.signal });

    expect(disks).toEqual([{ name: 'media', freeSize: 6000, totalSize: 464000, error: undefined }]);
    expect(get).toHaveBeenCalledWith(
      'http://10.0.0.219:8000/mount',
      expect.objectContaining({ signal: controller.signal, skipAutoProbe: true, timeout: expect.any(Number) })
    );
    expect(get.mock.calls[0][1].timeout).toBeLessThanOrEqual(10000);
  });

  test('works without options (older callers)', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
    await expect(AuthService.getAvailableDisks('10.0.0.219:8000')).resolves.toEqual([]);
  });

  test('a cancelled lookup is rethrown as a cancel, not reported as a connection problem', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new axios.CanceledError('canceled'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

    const error = await AuthService.getAvailableDisks('10.0.0.219:8000').catch((e) => e);

    expect(axios.isCancel(error)).toBe(true);
    expect(quiet).not.toHaveBeenCalled();
  });

  test('a network failure becomes the friendly error', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('Network Error'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(AuthService.getAvailableDisks('10.0.0.219:8000')).rejects.toThrow(
      'Could not connect to server to fetch storage info'
    );
  });
});

describe('getOriginalsLocation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    SecureStore.getItemAsync.mockReset();
    AuthService.serverUrl = null;
    AuthService.token = null;
  });
  const signedIn = (users) => {
    AuthService.serverUrl = 'http://10.0.0.219:8000';
    AuthService.token = 'tok';
    SecureStore.getItemAsync.mockImplementation(async (key) => (key === 'lomo_username' ? 'Alice' : null));
    return jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { Users: users } });
  };

  test("is the signed-in account's home folder plus Photos/master, with the computer's separator", async () => {
    const get = signedIn([
      { Name: 'bob', HomeDir: 'C:\\Users\\me\\Pictures\\Lomorage\\bob' },
      { Name: 'alice', HomeDir: 'C:\\Users\\me\\Pictures\\Lomorage\\alice' },
    ]);
    await expect(AuthService.getOriginalsLocation()).resolves.toBe('C:\\Users\\me\\Pictures\\Lomorage\\alice\\Photos\\master');
    expect(get).toHaveBeenCalledWith(
      'http://10.0.0.219:8000/user',
      expect.objectContaining({ headers: { Authorization: 'token=tok' } })
    );
  });

  test('uses slashes for a Linux/NAS path and ignores a trailing slash', async () => {
    signedIn([{ Name: 'alice', HomeDir: '/media/disk1/alice/' }]);
    await expect(AuthService.getOriginalsLocation()).resolves.toBe('/media/disk1/alice/Photos/master');
  });

  test('null when signed out, when the account is not listed, or when the request fails', async () => {
    await expect(AuthService.getOriginalsLocation()).resolves.toBeNull();
    signedIn([{ Name: 'bob', HomeDir: '/media/bob' }]);
    await expect(AuthService.getOriginalsLocation()).resolves.toBeNull();
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('Network Error'));
    await expect(AuthService.getOriginalsLocation()).resolves.toBeNull();
  });
});

describe('session expiry (401)', () => {
  // The interceptor AuthService registers last on the shared axios instance.
  const onError = () => axios.interceptors.response.handlers.filter(Boolean).at(-1).rejected;
  const unauthorized = (config) => ({ response: { status: 401 }, config });
  let expired;

  beforeEach(() => {
    AuthService.token = 'token-b';
    AuthService._isShowingSessionAlert = false;
    expired = jest.fn();
    AuthService._onSessionExpired = expired;
  });

  test('a 401 for the current sign-in signs out', async () => {
    await expect(onError()(unauthorized({ url: 'http://pc/assets/names', headers: { Authorization: 'token=token-b' } })))
      .rejects.toBeTruthy();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test("a late 401 for an earlier sign-in's request leaves the current one alone", async () => {
    await expect(onError()(unauthorized({ url: 'http://pc/assets/names', headers: { Authorization: 'token=token-a' } })))
      .rejects.toBeTruthy();
    await expect(onError()(unauthorized({ url: 'http://pc/preview/h?token=token-a' }))).rejects.toBeTruthy();
    expect(expired).not.toHaveBeenCalled();
  });

  test('a 401 for a request without a token still signs out', async () => {
    await expect(onError()(unauthorized({ url: 'http://pc/user' }))).rejects.toBeTruthy();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test('reads the token from the header, the URL or the params', () => {
    expect(tokenOfRequest({ headers: { Authorization: 'token=abc' } })).toBe('abc');
    expect(tokenOfRequest({ url: 'http://pc/a?x=1&token=a%2Bb' })).toBe('a+b');
    expect(tokenOfRequest({ params: { token: 'p' } })).toBe('p');
    expect(tokenOfRequest({ headers: { Authorization: 'Basic xyz' } })).toBeNull();
    expect(tokenOfRequest(undefined)).toBeNull();
  });
});

describe('account id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AuthService.token = 't';
    AuthService.username = 'Alice';
    AuthService.userId = '7';
    AuthService.serverUuid = null;
  });

  test('is the server id from /system and the user id, the same for any token', async () => {
    expect(AuthService.getAccountId()).toBeNull();
    await AuthService.applySystemInfo({ UUID: 'srv-1' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomo_server_uuid', 'srv-1');
    expect(AuthService.getAccountId()).toBe('srv-1|id:7');
    AuthService.token = 'another-sign-in';
    expect(AuthService.getAccountId()).toBe('srv-1|id:7');
    AuthService.userId = '8';
    expect(AuthService.getAccountId()).toBe('srv-1|id:8');
  });

  test('"Alice" and "alice" are two accounts, also without a user id from an older sign-in', async () => {
    await AuthService.applySystemInfo({ UUID: 'srv-1' });
    AuthService.userId = null;
    const alice = AuthService.getAccountId();
    AuthService.username = 'alice';
    expect(AuthService.getAccountId()).not.toBe(alice);
  });

  test('signing in keeps the user id from the answer', async () => {
    const get = jest.spyOn(axios, 'get').mockImplementation(async (url) => (url.endsWith('/login')
      ? { status: 200, data: { Token: 'tok', Userid: 12 } }
      : { status: 200, data: { UUID: 'srv-2' } }));
    require('react-native-argon2').mockResolvedValue({ rawHash: 'h', encodedHash: 'h' });
    SecureStore.deleteItemAsync.mockResolvedValue();
    SecureStore.setItemAsync.mockResolvedValue();
    await AuthService.login('192.168.1.5:8000', 'alice', 'pw');
    expect(AuthService.getAccountId()).toBe('srv-2|id:12');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomo_user_id', '12');
    get.mockRestore();
  });

  test('a late /system answer from before signing in again is not taken as this server', async () => {
    await AuthService.applySystemInfo({ UUID: 'srv-B' });
    const before = AuthService._session;
    AuthService._session += 1; // signed in again (e.g. to another server) meanwhile
    await AuthService.applySystemInfo({ UUID: 'srv-A' }, before);
    expect(AuthService.serverUuid).toBe('srv-B');
  });

  test('is null when signed out', async () => {
    await AuthService.applySystemInfo({ UUID: 'srv-1' });
    AuthService.token = null;
    expect(AuthService.getAccountId()).toBeNull();
  });
});

describe('connection probe across sign-ins', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('a probe from before signing in again does not point the app back at the old server', async () => {
    AuthService.localUrl = 'http://192.168.1.5:8000';
    AuthService.remoteUrl = 'https://old.example';
    AuthService.serverUrl = 'http://new-server:8000';
    jest.spyOn(AuthService, 'autoProbe').mockResolvedValue(false);
    const update = jest.spyOn(AuthService, 'updateServerUrl').mockResolvedValue();
    global.fetch = jest.fn(async () => {
      AuthService._session += 1; // signed in to another server while the old home address timed out
      throw new Error('aborted');
    });

    await expect(AuthService.determineBestConnection()).resolves.toBe(false);

    expect(global.fetch).toHaveBeenCalledTimes(1); // the old remote address isn't tried
    expect(update).not.toHaveBeenCalled();
    expect(AuthService.autoProbe).not.toHaveBeenCalled();
    update.mockRestore();
    AuthService.autoProbe.mockRestore();
  });

  test('a probe in the same sign-in still falls back to the remote address', async () => {
    AuthService.localUrl = 'http://192.168.1.5:8000';
    AuthService.remoteUrl = 'https://home.example';
    jest.spyOn(AuthService, 'autoProbe').mockResolvedValue(false);
    const update = jest.spyOn(AuthService, 'updateServerUrl').mockResolvedValue();
    global.fetch = jest.fn(async (url) => {
      if (url.startsWith('http://192.168.1.5')) throw new Error('aborted');
      return { status: 200, json: async () => ({}) };
    });

    await expect(AuthService.determineBestConnection()).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith('https://home.example');
    update.mockRestore();
    AuthService.autoProbe.mockRestore();
  });
});

describe('mDNS probe across sign-ins', () => {
  test('signing in again while the found address is being saved keeps the new server', async () => {
    jest.doMock('../DiscoveryService', () => ({
      __esModule: true,
      default: { scan: jest.fn().mockResolvedValue([{ name: 'old-pc', fullUrl: 'http://192.168.1.9:8000' }]) },
    }));
    AuthService.isProbing = false;
    AuthService.serverName = 'old-pc';
    AuthService.serverUrl = 'http://new-server:8000';
    const setLocal = jest.spyOn(AuthService, 'setLocalUrl').mockImplementation(async () => {
      AuthService._session += 1; // signed in to another server meanwhile
    });
    const update = jest.spyOn(AuthService, 'updateServerUrl').mockResolvedValue();

    await expect(AuthService.autoProbe()).resolves.toBe(false);

    expect(update).not.toHaveBeenCalled();
    setLocal.mockRestore();
    update.mockRestore();
    jest.dontMock('../DiscoveryService');
  });
});
