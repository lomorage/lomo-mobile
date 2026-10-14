jest.mock('../../../modules/expo-lomo-hasher', () => ({}));
jest.mock('../AuthService', () => ({}));
jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

const MediaLibrary = require('expo-media-library');
const { Platform, PermissionsAndroid } = require('react-native');
import MediaService, { MEDIA_PERMISSIONS } from '../MediaService';

const P = PermissionsAndroid.PERMISSIONS;
beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'android');
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({});
});

test('asks for and checks photos and videos only, never music & audio', async () => {
  MediaLibrary.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false });
  MediaLibrary.requestPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });

  await expect(MediaService.requestPermissions()).resolves.toBe(true);

  expect(MEDIA_PERMISSIONS).toEqual(['photo', 'video']);
  expect(MediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(false, ['photo', 'video']);
  expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(false, ['photo', 'video']);
  const asked = PermissionsAndroid.requestMultiple.mock.calls.flat(2);
  expect(asked).not.toContain(P.READ_MEDIA_AUDIO);
  expect(asked).not.toContain(P.ACCESS_FINE_LOCATION);
});

test('a user who allowed photos and videos is not asked again', async () => {
  MediaLibrary.getPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });
  PermissionsAndroid.check.mockResolvedValue(true);

  await expect(MediaService.requestPermissions()).resolves.toBe(true);

  expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('the status check used before explaining permissions also ignores audio', async () => {
  MediaLibrary.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
  await MediaService.getPermissionStatus();
  expect(MediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(false, ['photo', 'video']);
});
