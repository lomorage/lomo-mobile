jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock-cache/',
  documentDirectory: 'file:///mock-doc/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  deleteAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn().mockResolvedValue({ isConnected: true }),
}));
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1),
  getBatteryStateAsync: jest.fn().mockResolvedValue(2),
  BatteryState: { CHARGING: 2 },
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));
jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
jest.mock('expo-media-library', () => ({}));
jest.mock('expo-location', () => ({}));
jest.mock('./../AssetDBService', () => ({
  db: null,
  saveAssetOCR: jest.fn(),
  saveAssetMetadata: jest.fn(),
}));
jest.mock('./../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));
jest.mock('./../MediaService', () => ({
  getPreviewUrl: jest.fn(),
  getAssetInfo: jest.fn(),
}));
jest.mock('./../ModelAssetService', () => ({
  __esModule: true,
  default: {
    getModelPath: jest.fn(async (name) => name),
    isReady: jest.fn(async () => true),
    isDownloadAllowedNow: jest.fn(async () => true),
    ensureModels: jest.fn(async () => true),
  },
}));
jest.mock('./../TaskSchedulerService', () => ({
  waitUntilIdle: jest.fn().mockResolvedValue(),
}));
jest.mock('@infinitered/react-native-mlkit-text-recognition', () => ({
  recognizeText: jest.fn(),
}));
jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
  RNMLKitFaceDetector: jest.fn().mockImplementation(() => ({
    detectFaces: jest.fn().mockResolvedValue({ faces: [] }),
    initialize: jest.fn().mockResolvedValue(),
  })),
}));
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  encodeFaceEmbeddingAsync: jest.fn(),
  encodeImageEmbeddingAsync: jest.fn(),
  encodeTextEmbeddingAsync: jest.fn(),
  sliceFileAsync: jest.fn(),
}));
jest.mock('../../../modules/expo-background-keepalive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn() },
  Image: { getSize: jest.fn((uri, onSuccess) => onSuccess(200, 200)) },
  PixelRatio: { get: jest.fn(() => 2) },
}));
jest.mock('./../RemoteAlbumService', () => ({
  getAlbumsHierarchy: jest.fn().mockResolvedValue({ id: 'root' }),
}));

const axios = require('axios');
const FileSystem = require('expo-file-system/legacy');
const AuthService = require('./../AuthService');
const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
const TaskSchedulerService = require('./../TaskSchedulerService');
const RemoteAlbumService = require('./../RemoteAlbumService');
const { DeviceEventEmitter } = require('react-native');
const SecureStore = require('expo-secure-store');

import AIService from '../AIService';

describe('AIService._refreshFaceAlbumCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
    AuthService.getToken.mockReturnValue('test-token');
  });

  test('does nothing (leaves cache untouched) when there is no server/token', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    AIService.faceAlbumCache = 'unchanged-sentinel';
    await AIService._refreshFaceAlbumCache();
    expect(AIService.faceAlbumCache).toBe('unchanged-sentinel');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('filters the album list down to /Faces/ prefixed albums', async () => {
    axios.get.mockResolvedValue({
      data: {
        Albums: [
          { ID: 'a1', Title: '/Faces/alice' },
          { ID: 'a2', Title: '/Trips/hawaii' },
          { ID: 'a3', Title: '/Faces/bob' },
        ],
      },
    });
    await AIService._refreshFaceAlbumCache();
    expect(AIService.faceAlbumCache.map(a => a.id)).toEqual(['a1', 'a3']);
  });

  test('albums without a CoverImage get a null coverEmbedding, no file I/O', async () => {
    axios.get.mockResolvedValue({
      data: { Albums: [{ ID: 'a1', Title: '/Faces/alice' }] },
    });
    await AIService._refreshFaceAlbumCache();
    expect(AIService.faceAlbumCache).toEqual([{ id: 'a1', title: '/Faces/alice', coverEmbedding: null, count: 0 }]);
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  test('albums with a CoverImage get an embedding computed and the temp file cleaned up', async () => {
    axios.get.mockResolvedValue({
      data: { Albums: [{ ID: 'a1', Title: '/Faces/alice', CoverImage: 'base64imagedata' }] },
    });
    const fakeEmbeddingBase64 = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64');
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding: fakeEmbeddingBase64 });

    await AIService._refreshFaceAlbumCache();

    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringContaining('temp_face_cover_a1'),
      'base64imagedata',
      expect.objectContaining({ encoding: 'base64' })
    );
    expect(AIService.faceAlbumCache[0].coverEmbedding).toBeInstanceOf(Float32Array);
    expect(Array.from(AIService.faceAlbumCache[0].coverEmbedding)).toEqual([1, 2, 3]);
    // Temp file must be cleaned up regardless of outcome.
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining('temp_face_cover_a1'),
      expect.objectContaining({ idempotent: true })
    );
  });

  test('cleans up the temp file even when embedding generation throws', async () => {
    axios.get.mockResolvedValue({
      data: { Albums: [{ ID: 'a1', Title: '/Faces/alice', CoverImage: 'base64imagedata' }] },
    });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockRejectedValue(new Error('native module exploded'));

    await AIService._refreshFaceAlbumCache();

    expect(AIService.faceAlbumCache[0].coverEmbedding).toBeNull();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining('temp_face_cover_a1'),
      expect.objectContaining({ idempotent: true })
    );
  });

  test('resets the cache to empty (not left stale) when the album fetch itself fails', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    AIService.faceAlbumCache = [{ id: 'stale', title: 'stale', coverEmbedding: null }];

    await AIService._refreshFaceAlbumCache();

    expect(AIService.faceAlbumCache).toEqual([]);
  });

  test('yields to the JS thread/UI once per album that has a cover image, so a large library does not block for one long stretch', async () => {
    axios.get.mockResolvedValue({
      data: {
        Albums: [
          { ID: 'a1', Title: '/Faces/alice', CoverImage: 'data1' },
          { ID: 'a2', Title: '/Faces/bob', CoverImage: 'data2' },
          { ID: 'a3', Title: '/Faces/carol', CoverImage: 'data3' },
        ],
      },
    });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding: null });

    await AIService._refreshFaceAlbumCache();

    expect(TaskSchedulerService.waitUntilIdle).toHaveBeenCalledTimes(3);
    expect(AIService.faceAlbumCache).toHaveLength(3);
  });

  test('does not yield for albums with no cover image (nothing expensive happened, no need to pause)', async () => {
    axios.get.mockResolvedValue({
      data: {
        Albums: [
          { ID: 'a1', Title: '/Faces/alice' },
          { ID: 'a2', Title: '/Faces/bob' },
        ],
      },
    });

    await AIService._refreshFaceAlbumCache();

    expect(TaskSchedulerService.waitUntilIdle).not.toHaveBeenCalled();
  });

  test('merges two face albums whose covers are the same person and reloads the survivor', async () => {
    const embedding = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding });
    axios.get
      .mockResolvedValueOnce({
        data: {
          Albums: [
            { ID: 2, Title: '/Faces/unamed-a', CoverImage: 'cover-a', AssetsCount: 1 },
            { ID: 3, Title: '/Faces/unamed-b', CoverImage: 'cover-b', AssetsCount: 4 },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { Albums: [{ ID: 3, Title: '/Faces/unamed-a', CoverImage: 'cover-a' }] },
      });
    axios.post.mockResolvedValue({ status: 200 });

    await AIService._refreshFaceAlbumCache();

    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/album/merge',
      { Title: '/Faces/unamed-b', AlbumIDs: [2, 3] },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'token=test-token' }) })
    );
    expect(AIService.faceAlbumCache.map(album => album.id)).toEqual([3]);
    expect(RemoteAlbumService.getAlbumsHierarchy).toHaveBeenCalledWith(
      expect.objectContaining({ nullOnError: true })
    );
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('albumDeleted');
  });

  test('leaves the on-screen album list alone when the reload after a merge fails', async () => {
    const embedding = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding });
    axios.get
      .mockResolvedValueOnce({
        data: {
          Albums: [
            { ID: 2, Title: '/Faces/unamed-a', CoverImage: 'cover-a', AssetsCount: 1 },
            { ID: 3, Title: '/Faces/unamed-b', CoverImage: 'cover-b', AssetsCount: 4 },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { Albums: [{ ID: 3, Title: '/Faces/unamed-a', CoverImage: 'cover-a' }] },
      });
    axios.post.mockResolvedValue({ status: 200 });
    RemoteAlbumService.getAlbumsHierarchy.mockResolvedValueOnce(null);

    await AIService._refreshFaceAlbumCache();

    expect(AIService.faceAlbumCache.map(album => album.id)).toEqual([3]);
    expect(DeviceEventEmitter.emit).not.toHaveBeenCalled();
  });

  test('keeps the survivor in the match cache when the reload after a merge fails', async () => {
    const embedding = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding });
    axios.get
      .mockResolvedValueOnce({
        data: {
          Albums: [
            { ID: 2, Title: '/Faces/unamed-a', CoverImage: 'cover-a', AssetsCount: 1 },
            { ID: 3, Title: '/Faces/Mom', CoverImage: 'cover-b', AssetsCount: 4 },
          ],
        },
      })
      .mockRejectedValueOnce(new Error('reload failed'));
    axios.post.mockResolvedValue({ status: 200 });

    await AIService._refreshFaceAlbumCache();

    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/album/merge',
      { Title: '/Faces/Mom', AlbumIDs: [2, 3] },
      expect.any(Object)
    );
    expect(AIService.faceAlbumCache.map(album => album.id)).toEqual([3]);
    expect(AIService.faceAlbumCache[0].title).toBe('/Faces/Mom');
  });

  test('does not merge face albums while an existing install is still in dry-run', async () => {
    const embedding = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding });
    SecureStore.getItemAsync.mockImplementation(async (key) => {
      if (key === 'lomo_device_id') return 'device-1';
      return null;
    });
    axios.get.mockResolvedValue({
      data: {
        Albums: [
          { ID: 2, Title: '/Faces/unamed-a', CoverImage: 'cover-a', AssetsCount: 1 },
          { ID: 3, Title: '/Faces/Mom', CoverImage: 'cover-b', AssetsCount: 4 },
        ],
      },
    });

    await AIService._refreshFaceAlbumCache();

    expect(axios.post).not.toHaveBeenCalled();
    expect(AIService.faceAlbumCache).toHaveLength(2);
  });

  test('still yields after a cover-image album even if embedding generation failed for it', async () => {
    axios.get.mockResolvedValue({
      data: { Albums: [{ ID: 'a1', Title: '/Faces/alice', CoverImage: 'data1' }] },
    });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockRejectedValue(new Error('native module exploded'));

    await AIService._refreshFaceAlbumCache();

    expect(TaskSchedulerService.waitUntilIdle).toHaveBeenCalledTimes(1);
  });
});
