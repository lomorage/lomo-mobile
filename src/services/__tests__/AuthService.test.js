jest.mock('react-native-argon2', () => jest.fn());
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { formatServerUrl } from '../AuthService';

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
