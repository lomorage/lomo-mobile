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
import AuthService, { formatServerUrl } from '../AuthService';

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
    AuthService.serverUrl = null;
    AuthService.token = null;
  });
  const signedIn = (users) => {
    AuthService.serverUrl = 'http://10.0.0.219:8000';
    AuthService.token = 'tok';
    SecureStore.getItemAsync.mockImplementation(async (key) => (key === 'lomo_username' ? 'alice' : null));
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
