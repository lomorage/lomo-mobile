// Copying phone-album membership to server albums before Free Up Space deletes the photos.

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-media-library', () => ({
  getAlbumsAsync: jest.fn(),
  getAssetsAsync: jest.fn(),
  getAssetInfoAsync: jest.fn(),
  MediaType: { photo: 'photo', video: 'video' },
}));
jest.mock('../AssetDBService', () => ({ getBackupRowsByIds: jest.fn() }));
jest.mock('../RemoteAlbumService', () => ({
  getAlbums: jest.fn(),
  createAlbum: jest.fn(),
  getAllAlbumAssetHashes: jest.fn(),
  addAssetsToAlbum: jest.fn(),
}));

const { Platform } = require('react-native');
const MediaLibrary = require('expo-media-library');
const AssetDBService = require('../AssetDBService');
const RemoteAlbumService = require('../RemoteAlbumService');
import PhoneAlbumService from '../PhoneAlbumService';

// albums: { id: { title, ids: [...] } }; pages of 2 to exercise paging.
function phoneLibrary(albums) {
  MediaLibrary.getAlbumsAsync.mockResolvedValue(
    Object.entries(albums).map(([id, a]) => ({ id, title: a.title, assetCount: a.ids.length }))
  );
  MediaLibrary.getAssetsAsync.mockImplementation(async ({ album, after }) => {
    const ids = albums[album].ids;
    const start = after ? Number(after) : 0;
    const slice = ids.slice(start, start + 2);
    const end = start + slice.length;
    return { assets: slice.map(id => ({ id })), hasNextPage: end < ids.length, endCursor: String(end) };
  });
  // Android: each photo knows its folder.
  MediaLibrary.getAssetInfoAsync.mockImplementation(async (id) => {
    const entry = Object.entries(albums).find(([, a]) => a.ids.includes(id));
    return { id, albumId: entry ? entry[0] : undefined };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  AssetDBService.getBackupRowsByIds.mockImplementation(async (ids) => ids.map(id => ({ id, hash: `h-${id}` })));
  RemoteAlbumService.getAlbums.mockResolvedValue([]);
  RemoteAlbumService.createAlbum.mockImplementation(async (title) => ({ id: `srv-${title}`, name: title }));
  RemoteAlbumService.getAllAlbumAssetHashes.mockResolvedValue(new Set());
  RemoteAlbumService.addAssetsToAlbum.mockResolvedValue();
});

test('finds the albums the photos are in, across pages, ignoring the Android Camera folder', async () => {
  phoneLibrary({
    cam: { title: 'Camera', ids: ['1', '2'] },
    work: { title: 'Lucrari', ids: ['3', '4', '5', '6', '7'] },
    other: { title: 'Holiday', ids: ['8'] },
  });
  const result = await PhoneAlbumService.findAlbumMembership(['local-1', '5', '7']);
  expect(result).toEqual([{ title: 'Lucrari', ids: ['5', '7'] }]);
});

test('creates a missing server album and adds the photos by hash', async () => {
  phoneLibrary({ work: { title: 'Lucrari', ids: ['3', '4'] } });
  const result = await PhoneAlbumService.copyAlbumsToServer(['3', '4']);
  expect(RemoteAlbumService.createAlbum).toHaveBeenCalledWith('Lucrari');
  expect(RemoteAlbumService.addAssetsToAlbum).toHaveBeenCalledWith('srv-Lucrari', ['h-3', 'h-4']);
  expect(result).toEqual({ albums: 1, added: 2 });
});

test('reuses a server album of the same name and leaves out photos already in it', async () => {
  phoneLibrary({ work: { title: 'Lucrari', ids: ['3', '4'] } });
  RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 9, name: 'Lucrari' }]);
  RemoteAlbumService.getAllAlbumAssetHashes.mockResolvedValue(new Set(['h-3']));
  await PhoneAlbumService.copyAlbumsToServer(['3', '4']);
  expect(RemoteAlbumService.createAlbum).not.toHaveBeenCalled();
  expect(RemoteAlbumService.addAssetsToAlbum).toHaveBeenCalledWith(9, ['h-4']);
});

test('does nothing on the server when none of the photos is in an album', async () => {
  phoneLibrary({ cam: { title: 'Camera', ids: ['1'] } });
  expect(await PhoneAlbumService.copyAlbumsToServer(['1'])).toEqual({ albums: 0, added: 0 });
  expect(RemoteAlbumService.getAlbums).not.toHaveBeenCalled();
});

test('fails rather than guessing when the server albums cannot be read', async () => {
  phoneLibrary({ work: { title: 'Lucrari', ids: ['3'] } });
  RemoteAlbumService.getAlbums.mockResolvedValue(null);
  await expect(PhoneAlbumService.copyAlbumsToServer(['3'])).rejects.toThrow();
  expect(RemoteAlbumService.addAssetsToAlbum).not.toHaveBeenCalled();
});

test('passes on a refused add, so the caller can hold off deleting', async () => {
  phoneLibrary({ work: { title: 'Lucrari', ids: ['3'] } });
  RemoteAlbumService.addAssetsToAlbum.mockRejectedValue(new Error('500'));
  await expect(PhoneAlbumService.copyAlbumsToServer(['3'])).rejects.toThrow('500');
});

test('on iOS a photo in several albums is added to each; Camera is not special there', async () => {
  Platform.OS = 'ios';
  phoneLibrary({
    a: { title: 'Camera', ids: ['1'] },
    b: { title: 'Family', ids: ['1', '2'] },
  });
  await PhoneAlbumService.copyAlbumsToServer(['1']);
  expect(RemoteAlbumService.addAssetsToAlbum).toHaveBeenCalledWith('srv-Camera', ['h-1']);
  expect(RemoteAlbumService.addAssetsToAlbum).toHaveBeenCalledWith('srv-Family', ['h-1']);
});

test('Android, a few photos: asks each photo for its album instead of reading every album', async () => {
  phoneLibrary({
    cam: { title: 'Camera', ids: ['1', '2'] },
    work: { title: 'Lucrari', ids: ['3', '4'] },
  });
  const result = await PhoneAlbumService.findAlbumMembership(['1', '4']);
  expect(result).toEqual([{ title: 'Lucrari', ids: ['4'] }]);
  expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
});

test('Android, many photos: reads the albums, and stops once every photo is found', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `w${i}`);
  phoneLibrary({
    work: { title: 'Lucrari', ids: many },
    later: { title: 'Untouched', ids: ['x1'] },
  });
  const result = await PhoneAlbumService.findAlbumMembership(many);
  expect(result).toEqual([{ title: 'Lucrari', ids: many }]);
  expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
  expect(MediaLibrary.getAssetsAsync.mock.calls.every(([q]) => q.album === 'work')).toBe(true);
});

test('a "/" in a phone album name does not become a folder on the server', async () => {
  phoneLibrary({ s: { title: '2024/25 Season', ids: ['3'] } });
  await PhoneAlbumService.copyAlbumsToServer(['3']);
  expect(RemoteAlbumService.createAlbum).toHaveBeenCalledWith('2024-25 Season');
});
