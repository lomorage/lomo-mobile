jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///mock-doc/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  deleteAsync: jest.fn().mockResolvedValue(),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200, uri: 'file:///mock-doc/lomo_favorites/cached.jpg' }),
}));
jest.mock('react-native', () => ({
  DeviceEventEmitter: { emit: jest.fn() },
}));
jest.mock('../AssetDBService', () => ({
  db: { getAllAsync: jest.fn().mockResolvedValue([]) },
  syncFavoriteStatus: jest.fn().mockResolvedValue(),
  updateAssetCachePath: jest.fn().mockResolvedValue(),
  getFavoriteAssetsToCache: jest.fn().mockResolvedValue([]),
  setAssetFavoriteStatus: jest.fn().mockResolvedValue(),
}));
jest.mock('../RemoteAlbumService', () => ({
  getAlbums: jest.fn().mockResolvedValue([]),
  createAlbum: jest.fn(),
  getAlbumAssets: jest.fn().mockResolvedValue([]),
  addAssetToAlbum: jest.fn().mockResolvedValue(),
  removeAssetFromAlbum: jest.fn().mockResolvedValue(),
}));
jest.mock('../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));

const FileSystem = require('expo-file-system/legacy');
const { DeviceEventEmitter } = require('react-native');
const AssetDBService = require('../AssetDBService');
const RemoteAlbumService = require('../RemoteAlbumService');
const AuthService = require('../AuthService');

import OfflineCacheService from '../OfflineCacheService';

beforeEach(() => {
  jest.clearAllMocks();
  OfflineCacheService.isSyncing = false;
  AssetDBService.db = { getAllAsync: jest.fn().mockResolvedValue([]) };
  RemoteAlbumService.getAlbums.mockResolvedValue([]);
  AssetDBService.getFavoriteAssetsToCache.mockResolvedValue([]);
  AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
  AuthService.getToken.mockReturnValue('test-token');
});

describe('syncFavoritesFromServer', () => {
  test('is a no-op when already syncing', async () => {
    OfflineCacheService.isSyncing = true;
    await OfflineCacheService.syncFavoritesFromServer();
    expect(RemoteAlbumService.getAlbums).not.toHaveBeenCalled();
  });

  test('creates the /Favorites album when it does not exist yet, then syncs', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([]);
    RemoteAlbumService.createAlbum.mockResolvedValue({ id: 'fav1', name: '/Favorites' });
    RemoteAlbumService.getAlbumAssets.mockResolvedValue(['hash1', 'hash2']);

    await OfflineCacheService.syncFavoritesFromServer();

    expect(RemoteAlbumService.createAlbum).toHaveBeenCalledWith('/Favorites');
    expect(AssetDBService.syncFavoriteStatus).toHaveBeenCalledWith(['hash1', 'hash2']);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('remoteAssetsUpdated');
    expect(OfflineCacheService.isSyncing).toBe(false);
  });

  test('reuses an existing /Favorites album instead of creating a duplicate', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 'fav1', name: '/Favorites' }]);
    await OfflineCacheService.syncFavoritesFromServer();
    expect(RemoteAlbumService.createAlbum).not.toHaveBeenCalled();
  });

  test('resets isSyncing (does not stay stuck) when album creation fails', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([]);
    RemoteAlbumService.createAlbum.mockResolvedValue(null);
    await OfflineCacheService.syncFavoritesFromServer();
    expect(OfflineCacheService.isSyncing).toBe(false);
    expect(AssetDBService.syncFavoriteStatus).not.toHaveBeenCalled();
  });

  test('resets isSyncing when the DB is not ready yet', async () => {
    AssetDBService.db = null;
    RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 'fav1', name: '/Favorites' }]);
    await OfflineCacheService.syncFavoritesFromServer();
    expect(OfflineCacheService.isSyncing).toBe(false);
    expect(AssetDBService.syncFavoriteStatus).not.toHaveBeenCalled();
  });

  test('resets isSyncing even when an unexpected error is thrown mid-sync', async () => {
    RemoteAlbumService.getAlbums.mockRejectedValue(new Error('network down'));
    await expect(OfflineCacheService.syncFavoritesFromServer()).resolves.toBeUndefined();
    expect(OfflineCacheService.isSyncing).toBe(false);
  });
});

describe('cleanupRemovedFavorites', () => {
  test('deletes the cached file and clears the cache path for un-favorited assets', async () => {
    AssetDBService.db.getAllAsync.mockResolvedValue([{ id: 'a1', localCachePath: 'file:///mock-doc/lomo_favorites/a1.jpg' }]);
    FileSystem.getInfoAsync.mockResolvedValue({ exists: true });

    await OfflineCacheService.cleanupRemovedFavorites();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///mock-doc/lomo_favorites/a1.jpg',
      expect.objectContaining({ idempotent: true })
    );
    expect(AssetDBService.updateAssetCachePath).toHaveBeenCalledWith('a1', null);
  });

  test('skips deleteAsync when the file is already gone, but still clears the DB path', async () => {
    AssetDBService.db.getAllAsync.mockResolvedValue([{ id: 'a1', localCachePath: 'file:///gone.jpg' }]);
    FileSystem.getInfoAsync.mockResolvedValue({ exists: false });

    await OfflineCacheService.cleanupRemovedFavorites();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(AssetDBService.updateAssetCachePath).toHaveBeenCalledWith('a1', null);
  });

  test('one row failing does not stop cleanup of the rest', async () => {
    AssetDBService.db.getAllAsync.mockResolvedValue([
      { id: 'bad', localCachePath: 'file:///bad.jpg' },
      { id: 'good', localCachePath: 'file:///good.jpg' },
    ]);
    FileSystem.getInfoAsync.mockImplementation((path) =>
      path === 'file:///bad.jpg' ? Promise.reject(new Error('stat failed')) : Promise.resolve({ exists: true })
    );

    await OfflineCacheService.cleanupRemovedFavorites();

    expect(AssetDBService.updateAssetCachePath).toHaveBeenCalledWith('good', null);
    expect(AssetDBService.updateAssetCachePath).not.toHaveBeenCalledWith('bad', null);
  });

  test('is a no-op when the DB is not ready yet', async () => {
    AssetDBService.db = null;
    await expect(OfflineCacheService.cleanupRemovedFavorites()).resolves.toBeUndefined();
  });
});

describe('downloadPendingFavorites', () => {
  test('does nothing when there is nothing pending', async () => {
    AssetDBService.getFavoriteAssetsToCache.mockResolvedValue([]);
    await OfflineCacheService.downloadPendingFavorites();
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  test('aborts without downloading when the server url/token are missing', async () => {
    AssetDBService.getFavoriteAssetsToCache.mockResolvedValue([{ hash: 'h1', mediaType: 'photo' }]);
    AuthService.getServerUrl.mockReturnValue(null);
    await OfflineCacheService.downloadPendingFavorites();
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  test('downloads each pending favorite and records its local cache path', async () => {
    AssetDBService.getFavoriteAssetsToCache.mockResolvedValue([{ hash: 'h1', mediaType: 'photo' }]);
    await OfflineCacheService.downloadPendingFavorites();
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
      expect.stringContaining('/asset/h1?token=test-token'),
      expect.stringContaining('h1.jpg')
    );
    expect(AssetDBService.updateAssetCachePath).toHaveBeenCalledWith('h1', 'file:///mock-doc/lomo_favorites/cached.jpg');
  });

  test('one failed download does not stop the rest of the batch', async () => {
    AssetDBService.getFavoriteAssetsToCache.mockResolvedValue([
      { hash: 'bad', mediaType: 'photo' },
      { hash: 'good', mediaType: 'photo' },
    ]);
    FileSystem.downloadAsync.mockImplementation((remoteUri) =>
      remoteUri.includes('bad')
        ? Promise.reject(new Error('network error'))
        : Promise.resolve({ status: 200, uri: 'file:///good.jpg' })
    );

    await OfflineCacheService.downloadPendingFavorites();

    expect(AssetDBService.updateAssetCachePath).toHaveBeenCalledWith('good', 'file:///good.jpg');
    expect(AssetDBService.updateAssetCachePath).not.toHaveBeenCalledWith('bad', expect.anything());
  });
});

describe('toggleFavorite', () => {
  test('updates SQLite optimistically and emits an update event before touching the server', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 'fav1', name: '/Favorites' }]);
    await OfflineCacheService.toggleFavorite('hash1', true);
    expect(AssetDBService.setAssetFavoriteStatus).toHaveBeenCalledWith('hash1', true);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('remoteAssetsUpdated');
  });

  test('adds the asset to the /Favorites album when favoriting', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 'fav1', name: '/Favorites' }]);
    await OfflineCacheService.toggleFavorite('hash1', true);
    expect(RemoteAlbumService.addAssetToAlbum).toHaveBeenCalledWith('fav1', 'hash1');
    expect(RemoteAlbumService.removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  test('removes the asset from the /Favorites album when un-favoriting', async () => {
    RemoteAlbumService.getAlbums.mockResolvedValue([{ id: 'fav1', name: '/Favorites' }]);
    await OfflineCacheService.toggleFavorite('hash1', false);
    expect(RemoteAlbumService.removeAssetFromAlbum).toHaveBeenCalledWith('fav1', 'hash1');
    expect(RemoteAlbumService.addAssetToAlbum).not.toHaveBeenCalled();
  });

  test('does not throw if the server-side update fails (already applied locally)', async () => {
    RemoteAlbumService.getAlbums.mockRejectedValue(new Error('network down'));
    await expect(OfflineCacheService.toggleFavorite('hash1', true)).resolves.toBeUndefined();
    expect(AssetDBService.setAssetFavoriteStatus).toHaveBeenCalledWith('hash1', true);
  });
});
