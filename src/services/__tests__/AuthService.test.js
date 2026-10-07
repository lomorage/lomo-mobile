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
