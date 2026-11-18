// Face detection failures through the real wrapper and the real reporter:
// only the native module (expo-modules-core) and Crashlytics are replaced.
// The package's own RNMLKitFaceDetector swallowed native rejections and
// resolved undefined, which other test files could not see because they mock
// the detector object itself.

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
  getItemAsync: jest.fn().mockResolvedValue(null),
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
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
}));
jest.mock('./../AssetDBService', () => ({
  db: null,
  saveAssetOCR: jest.fn(),
  saveAssetMetadata: jest.fn(),
  markLocationChecked: jest.fn(),
}));
jest.mock('./../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
  determineBestConnection: jest.fn().mockResolvedValue(),
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
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  encodeFaceEmbeddingAsync: jest.fn(),
  encodeImageEmbeddingAsync: jest.fn(),
  encodeTextEmbeddingAsync: jest.fn(),
  prepareAnalysisImageAsync: jest.fn(),
  generatePHashAsync: jest.fn(),
  sliceFileAsync: jest.fn(),
}));
jest.mock('../../../modules/expo-background-keepalive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })), currentState: 'active' },
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn() },
  Image: { getSize: jest.fn((uri, onSuccess) => onSuccess(200, 200)) },
  PixelRatio: { get: jest.fn(() => 2) },
}));

// The native RNMLKitFaceDetection module, as expo-modules-core returns it.
const mockNativeFace = {
  initialize: jest.fn(),
  detectFaces: jest.fn(),
};
jest.mock('expo-modules-core', () => ({
  requireNativeModule: jest.fn((name) => (name === 'RNMLKitFaceDetection' ? mockNativeFace : {})),
}));
jest.mock('@react-native-firebase/crashlytics', () => {
  const instance = { tag: 'crashlytics' };
  return {
    getCrashlytics: jest.fn(() => instance),
    log: jest.fn(),
    recordError: jest.fn(),
  };
});

const SecureStore = require('expo-secure-store');
const AssetDBService = require('./../AssetDBService');
const MediaService = require('./../MediaService');
const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
const crashlytics = require('@react-native-firebase/crashlytics');
const { _resetCrashReportingForTests } = require('../crashReporting');

import AIService from '../AIService';

const PHOTO_URI = 'file:///storage/emulated/0/DCIM/Camera/IMG_20261117_231000.jpg';

// What JS receives when RNMLKitImage cannot read the file: Expo's wrapper
// around the module's handleException text, which embeds the full uri.
function imageLoadRejection() {
  return new Error(
    "Call to function 'RNMLKitFaceDetection.detectFaces' has been rejected.\n" +
    `→ Caused by: RNMLKitFaceDetection - Error: RNMLKitImage: Could not load image from ${PHOTO_URI}`
  );
}

function oneLocalPhotoDb() {
  let served = false;
  return {
    getFirstAsync: jest.fn(async (sql) => (
      typeof sql === 'string' && sql.includes('COUNT(*)') ? { count: 1 } : { count: 0 }
    )),
    getAllAsync: jest.fn(async () => {
      if (served) return [];
      served = true;
      return [{
        id: 7,
        hash: 'abc',
        isLocal: 1,
        clipEmbeddingVersion: 1,
        phash: '1',
        ocrText: 'done',
        faceRecVersion: 0,
      }];
    }),
    runAsync: jest.fn().mockResolvedValue(),
  };
}

function faceRecWrites(db) {
  return db.runAsync.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('SET faceRecVersion = ?'))
    .map(([, params]) => params);
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetCrashReportingForTests();
  AIService.isProcessing = false;
  AIService._faceDetectChain = null;
  SecureStore.getItemAsync.mockResolvedValue(null);
  mockNativeFace.initialize.mockResolvedValue(null);
  mockNativeFace.detectFaces.mockResolvedValue({ faces: [] });
});

describe('background scan, native face detection rejects', () => {
  beforeEach(() => {
    MediaService.getAssetInfo.mockResolvedValue({ localUri: PHOTO_URI, uri: PHOTO_URI, width: 20, height: 20 });
    // Small and upright: the original uri goes to ML Kit unchanged.
    ExpoLomoHasher.prepareAnalysisImageAsync.mockResolvedValue({ uri: PHOTO_URI, width: 20, height: 20, scale: 1 });
  });

  test('marks the photo failed (-1), not done with no faces', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValueOnce(imageLoadRejection());

    await AIService.processLocalEmbeddings(10, true);

    expect(mockNativeFace.detectFaces).toHaveBeenCalledWith(PHOTO_URI);
    expect(faceRecWrites(db)).toEqual([[-1, 7]]);
  });

  test('marks the photo done (1) when detection succeeds with no faces', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;

    await AIService.processLocalEmbeddings(10, true);

    expect(faceRecWrites(db)).toEqual([[1, 7]]);
    expect(crashlytics.recordError).not.toHaveBeenCalled();
  });

  test('sends Crashlytics the cause and image size, with the path scrubbed everywhere', async () => {
    AssetDBService.db = oneLocalPhotoDb();
    mockNativeFace.detectFaces.mockRejectedValueOnce(imageLoadRejection());

    await AIService.processLocalEmbeddings(10, true);

    expect(crashlytics.recordError).toHaveBeenCalledTimes(1);
    const [, recorded, jsErrorName] = crashlytics.recordError.mock.calls[0];
    expect(jsErrorName).toBe('FaceDetectionError');
    expect(recorded.message).toContain('Could not load image from <uri>');

    const [, logLine] = crashlytics.log.mock.calls[0];
    const context = JSON.parse(logLine.slice('FaceDetectionError '.length));
    expect(context).toEqual({
      source: 'local',
      width: 20,
      height: 20,
      scale: 1,
      stage: 'detect',
      kind: 'load_failed',
      image: 'file',
      detector: 'strict',
      platform: 'android',
    });

    const everythingSent = JSON.stringify([
      crashlytics.log.mock.calls,
      recorded.message,
      recorded.stack,
    ]);
    expect(everythingSent).not.toMatch(/storage|DCIM|IMG_2026/);
  });
});

describe('manual cover pick, native face detection rejects', () => {
  test('returns detection_failed and reports it', async () => {
    ExpoLomoHasher.prepareAnalysisImageAsync.mockResolvedValueOnce({
      uri: 'file:///mock-cache/analysis-9.jpg', width: 2048, height: 1536, scale: 0.5,
    });
    mockNativeFace.detectFaces.mockRejectedValueOnce(new Error('RNMLKitFaceDetection - Error: Failed to run face detector.'));

    const result = await AIService.extractBestMatchingFaceCrop('content://media/external/images/media/9', 'cover-b64');

    expect(result).toEqual({ error: 'detection_failed' });
    expect(mockNativeFace.initialize).toHaveBeenCalledWith(expect.objectContaining({ minFaceSize: 0.02 }));
    const [, logLine] = crashlytics.log.mock.calls[0];
    expect(logLine).toContain('"kind":"run_failed"');
    expect(logLine).toContain('"image":"downscaled"');
    expect(logLine).toContain('"detector":"manual"');
  });

  test('reports a failed initialize as stage "initialize" and does not detect', async () => {
    mockNativeFace.initialize.mockRejectedValueOnce(new Error('Failed to init face detector.'));

    const result = await AIService.extractBestMatchingFaceCrop('file:///mock-cache/x.jpg', 'cover-b64');

    expect(result).toEqual({ error: 'detection_failed' });
    expect(mockNativeFace.detectFaces).not.toHaveBeenCalled();
    const [, logLine] = crashlytics.log.mock.calls[0];
    expect(logLine).toContain('"stage":"initialize"');
    expect(logLine).toContain('"kind":"init_failed"');
  });
});
