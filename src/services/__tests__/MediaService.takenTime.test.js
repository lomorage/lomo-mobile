jest.mock('../../../modules/expo-lomo-hasher', () => ({}));
jest.mock('../AuthService', () => ({}));
jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn() }));

const MediaLibrary = require('expo-media-library');
import MediaService from '../MediaService';

beforeEach(() => jest.clearAllMocks());

test('fills in only missing taken dates from known EXIF times', () => {
  const assets = [
    { id: 'a', creationTime: 0 },
    { id: 'b', creationTime: 0 },
    { id: 'c', creationTime: 123 },
    { id: 'd', creationTime: 0 },
  ];
  const applied = MediaService.applyKnownTakenTimes(assets, new Map([['a', 1000], ['b', 0], ['c', 9]]));
  expect(applied).toBe(1);
  expect(assets.map(a => a.creationTime)).toEqual([1000, 0, 123, 0]);
});

test('reads EXIF once for photos with no taken date, recording 0 when there is none', async () => {
  MediaLibrary.getAssetInfoAsync.mockImplementation(async (id) => ({
    id, exif: id === 'p1' ? { DateTimeOriginal: '2019:03:04 12:27:32' } : {},
  }));
  const assets = [
    { id: 'p1', creationTime: 0, mediaType: 'photo' },
    { id: 'p2', creationTime: 0, mediaType: 'photo' },
    { id: 'known', creationTime: 0, mediaType: 'photo' },
    { id: 'dated', creationTime: 5, mediaType: 'photo' },
    { id: 'video', creationTime: 0, mediaType: 'video' },
  ];
  const entries = await MediaService.readMissingTakenTimes(assets, new Map([['known', 7]]));
  expect(entries).toEqual([
    { id: 'p1', time: new Date(2019, 2, 4, 12, 27, 32).getTime() },
    { id: 'p2', time: 0 },
  ]);
  expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledTimes(2);
});

test('reads at most `limit` per run', async () => {
  MediaLibrary.getAssetInfoAsync.mockResolvedValue({ exif: {} });
  const assets = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, creationTime: 0, mediaType: 'photo' }));
  expect(await MediaService.readMissingTakenTimes(assets, new Map(), 2)).toHaveLength(2);
});
