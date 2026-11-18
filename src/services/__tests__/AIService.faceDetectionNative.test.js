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

  test('marks a first read failure as one failed load (-3), not done with no faces', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValueOnce(imageLoadRejection());

    await AIService.processLocalEmbeddings(10, true);

    expect(mockNativeFace.detectFaces).toHaveBeenCalledWith(PHOTO_URI);
    expect(faceRecWrites(db)).toEqual([[-3, 7]]);
  });

  test('marks a photo under 32px failed for good (-2)', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValueOnce(new Error('InputImage width and height should be at least 32!'));

    await AIService.processLocalEmbeddings(10, true);

    expect(faceRecWrites(db)).toEqual([[-2, 7]]);
  });

  test('marks a detector failure retryable (-1)', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValueOnce(new Error('RNMLKitFaceDetection - Error: Failed to run face detector.'));

    await AIService.processLocalEmbeddings(10, true);

    expect(faceRecWrites(db)).toEqual([[-1, 7]]);
  });

  test('an error after detection (embedding) is retryable even if its text looks like a load failure', async () => {
    const db = oneLocalPhotoDb();
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockResolvedValueOnce({
      faces: [{ frame: { origin: { x: 0, y: 0 }, size: { x: 15, y: 15 } } }],
    });
    // Too small to keep, so no embedding runs; force a failure after detection instead.
    jest.spyOn(AIService, '_partitionSubjectFaces').mockImplementationOnce(() => {
      throw new Error('Could not load image from somewhere');
    });

    await AIService.processLocalEmbeddings(10, true);

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
    expect(recorded.message).toBe('FaceDetectionError: load_failed');

    const [, logLine] = crashlytics.log.mock.calls[0];
    const context = JSON.parse(logLine.slice('FaceDetectionError '.length));
    expect(context).toEqual({
      source: 'local',
      width: 20,
      height: 20,
      scale: 1,
      stage: 'detect',
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

  test('sends nothing of a file name Android left unescaped (comma, space, bracket)', async () => {
    AssetDBService.db = oneLocalPhotoDb();
    const uri = 'file:///storage/emulated/0/DCIM/Trip, Alice (2).jpg';
    mockNativeFace.detectFaces.mockRejectedValueOnce(new Error(
      `RNMLKitFaceDetection - Error: RNMLKitImage: Could not load image from ${uri}`
    ));

    await AIService.processLocalEmbeddings(10, true);

    const sent = JSON.stringify([crashlytics.log.mock.calls, crashlytics.recordError.mock.calls[0][1].message,
      crashlytics.recordError.mock.calls[0][1].stack]);
    expect(sent).not.toMatch(/Alice|Trip|\(2\)|DCIM/);
  });
});

describe('faceRecFailureVersion', () => {
  const { faceRecFailureVersion } = require('../AIService');
  const tagged = (kind) => Object.assign(new Error('x'), { faceDetectionKind: kind });

  test.each([
    ['too_small', undefined, -2],
    ['too_small', -4, -2],
    ['load_failed', undefined, -3],
    ['load_failed', 0, -3],
    ['load_failed', -1, -3],
    ['load_failed', -3, -4],
    ['load_failed', -4, -2],
    ['run_failed', -3, -1],
    ['init_failed', undefined, -1],
  ])('%s after %p saves %p', (kind, previous, expected) => {
    expect(faceRecFailureVersion(tagged(kind), previous)).toBe(expected);
  });

  test('an untagged error is retryable whatever its text says', () => {
    expect(faceRecFailureVersion(new Error('InputImage width and height should be at least 32!'), 0)).toBe(-1);
  });
});

// Part C of syncEmbeddings, with its pending query run by real SQLite so the
// WHERE clause itself is what decides whether a photo comes back.
describe('remote photos, native face detection rejects', () => {
  const FileSystem = require('expo-file-system/legacy');
  const { DatabaseSync } = require('node:sqlite');
  const SecureStoreMock = require('expo-secure-store');

  function remoteDb(rows) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE MediaAsset (id TEXT, hash TEXT, isLocal INTEGER, clipEmbedding TEXT, faceRecVersion INTEGER)');
    const insert = sqlite.prepare('INSERT INTO MediaAsset VALUES (?, ?, 0, ?, ?)');
    for (const r of rows) insert.run(r.id, r.hash, r.clipEmbedding, r.faceRecVersion);
    // expo-sqlite accepts "none" as a string; node:sqlite only takes 'none'.
    const prep = (sql) => sqlite.prepare(sql.replace(/"([^"]*)"/g, "'$1'"));
    const isPartC = (sql) => sql.includes('faceRecVersion') && sql.includes('isLocal = 0');
    return {
      sqlite,
      getAllAsync: jest.fn(async (sql, params = []) => (isPartC(sql) ? prep(sql).all(...params) : [])),
      getFirstAsync: jest.fn(async (sql, params = []) => (isPartC(sql) ? prep(sql).get(...params) : { count: 0 })),
      runAsync: jest.fn(async (sql, params = []) => {
        if (sql.includes('SET faceRecVersion')) prep(sql).run(...params);
      }),
    };
  }

  const faceVersionOf = (db, id) =>
    db.sqlite.prepare('SELECT faceRecVersion FROM MediaAsset WHERE id = ?').get(id).faceRecVersion;

  beforeEach(() => {
    AIService.isSyncing = false;
    SecureStoreMock.getItemAsync.mockResolvedValue(null);
    FileSystem.downloadAsync.mockImplementation(async (_url, tempUri) => ({ status: 200, uri: tempUri }));
  });

  test('a preview too small for ML Kit is downloaded once, then left alone on later syncs', async () => {
    const db = remoteDb([{ id: 'r1', hash: 'h1', clipEmbedding: 'E', faceRecVersion: null }]);
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValue(new Error('InputImage width and height should be at least 32!'));

    await AIService.syncEmbeddings(true);
    AIService.isSyncing = false;
    await AIService.syncEmbeddings(true);

    expect(faceVersionOf(db, 'r1')).toBe(-2);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(1);
    expect(mockNativeFace.detectFaces).toHaveBeenCalledTimes(1);
  });

  test('an unreadable preview is retried twice more, then left alone', async () => {
    const db = remoteDb([{ id: 'r1', hash: 'h1', clipEmbedding: 'E', faceRecVersion: null }]);
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValue(new Error(
      'RNMLKitFaceDetection - Error: RNMLKitImage: Could not load image from file:///mock-cache/h1.jpg'
    ));

    const states = [];
    for (let sync = 0; sync < 4; sync += 1) {
      AIService.isSyncing = false;
      await AIService.syncEmbeddings(true);
      states.push(faceVersionOf(db, 'r1'));
    }

    expect(states).toEqual([-3, -4, -2, -2]);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(3);
  });

  test('a preview that reads on a later sync is detected normally', async () => {
    const db = remoteDb([{ id: 'r1', hash: 'h1', clipEmbedding: 'E', faceRecVersion: null }]);
    AssetDBService.db = db;
    mockNativeFace.detectFaces
      .mockRejectedValueOnce(new Error('RNMLKitImage: Could not load image from file:///mock-cache/h1.jpg'))
      .mockResolvedValueOnce({ faces: [] });

    await AIService.syncEmbeddings(true);
    AIService.isSyncing = false;
    await AIService.syncEmbeddings(true);

    expect(faceVersionOf(db, 'r1')).toBe(1);
  });

  test('a detector failure is retried on the next sync', async () => {
    const db = remoteDb([{ id: 'r1', hash: 'h1', clipEmbedding: 'E', faceRecVersion: null }]);
    AssetDBService.db = db;
    mockNativeFace.detectFaces.mockRejectedValue(new Error('Failed to run face detector.'));

    await AIService.syncEmbeddings(true);
    AIService.isSyncing = false;
    await AIService.syncEmbeddings(true);

    expect(faceVersionOf(db, 'r1')).toBe(-1);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(2);
  });

  test('a photo selected for its embedding does not rerun detection when its face state is final', async () => {
    const db = remoteDb([{ id: 'r1', hash: 'h1', clipEmbedding: 'none', faceRecVersion: -2 }]);
    AssetDBService.db = db;
    jest.spyOn(AIService, 'getImageEmbedding').mockResolvedValueOnce(null);
    jest.spyOn(AIService, 'saveAssetEmbedding').mockResolvedValueOnce();

    await AIService.syncEmbeddings(true);

    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(1);
    expect(mockNativeFace.detectFaces).not.toHaveBeenCalled();
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
    expect(crashlytics.recordError.mock.calls[0][1].message).toBe('FaceDetectionError: run_failed');
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
    expect(crashlytics.recordError.mock.calls[0][1].message).toBe('FaceDetectionError: init_failed');
  });
});
