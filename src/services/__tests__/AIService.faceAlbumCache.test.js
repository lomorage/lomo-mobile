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
jest.mock('./../TaskSchedulerService', () => ({
  waitUntilIdle: jest.fn().mockResolvedValue(),
}));
jest.mock('@infinitered/react-native-mlkit-text-recognition', () => ({
  recognizeText: jest.fn(),
}));
jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
  RNMLKitFaceDetector: jest.fn().mockImplementation(() => ({
    detectFaces: jest.fn().mockResolvedValue({ faces: [] }),
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

const axios = require('axios');
const FileSystem = require('expo-file-system/legacy');
const AuthService = require('./../AuthService');
const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');

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
    expect(AIService.faceAlbumCache).toEqual([{ id: 'a1', title: '/Faces/alice', coverEmbedding: null }]);
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
});
