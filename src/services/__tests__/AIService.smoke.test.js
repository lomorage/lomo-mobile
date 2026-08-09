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
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })), currentState: 'active' },
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn() },
  Image: { getSize: jest.fn((uri, onSuccess) => onSuccess(200, 200)) },
  PixelRatio: { get: jest.fn(() => 2) },
}));

const SecureStore = require('expo-secure-store');
const AssetDBService = require('./../AssetDBService');
const AuthService = require('./../AuthService');
const { DeviceEventEmitter } = require('react-native');

import AIService from '../AIService';

function makeEmptyDb() {
  return {
    getFirstAsync: jest.fn().mockResolvedValue({ count: 0 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue(),
  };
}

describe('AIService.processLocalEmbeddings (smoke)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AIService.isProcessing = false;
    AssetDBService.db = null;
    SecureStore.getItemAsync.mockResolvedValue(null);
  });

  test('is a no-op when already processing', async () => {
    AIService.isProcessing = true;
    await AIService.processLocalEmbeddings(10, true);
    // Guard clause returns before touching SecureStore at all.
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('skips when AI is disabled and force is false', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_ai_enabled' ? 'false' : null)
    );
    await AIService.processLocalEmbeddings(10, false);
    expect(AIService.isProcessing).toBe(false);
    // Never got far enough to touch the DB.
    expect(AssetDBService.db).toBeNull();
  });

  test('completes cleanly and resets isProcessing when there is nothing pending', async () => {
    AssetDBService.db = makeEmptyDb();
    await AIService.processLocalEmbeddings(10, true);
    expect(AIService.isProcessing).toBe(false);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(
      'ai_processing_status',
      expect.objectContaining({ isProcessing: false })
    );
  });

  test('does not throw and still resets isProcessing when the DB query itself fails', async () => {
    AssetDBService.db = {
      getFirstAsync: jest.fn().mockRejectedValue(new Error('sqlite is locked')),
      getAllAsync: jest.fn(),
      runAsync: jest.fn(),
    };
    await expect(AIService.processLocalEmbeddings(10, true)).resolves.toBeUndefined();
    expect(AIService.isProcessing).toBe(false);
  });
});

describe('AIService.syncEmbeddings (smoke)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AIService.isSyncing = false;
    AssetDBService.db = null;
    SecureStore.getItemAsync.mockResolvedValue(null);
    AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
    AuthService.getToken.mockReturnValue('test-token');
  });

  test('is a no-op when already syncing', async () => {
    AIService.isSyncing = true;
    await AIService.syncEmbeddings(true);
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('skips when AI is disabled and force is false', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_ai_enabled' ? 'false' : null)
    );
    await AIService.syncEmbeddings(false);
    expect(AIService.isSyncing).toBe(false);
    expect(AssetDBService.db).toBeNull();
  });

  test('aborts cleanly when server url/token are missing', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    await AIService.syncEmbeddings(true);
    expect(AIService.isSyncing).toBe(false);
    expect(AssetDBService.db).toBeNull();
  });

  test('completes cleanly and resets isSyncing when there is nothing to upload or download', async () => {
    AssetDBService.db = makeEmptyDb();
    await AIService.syncEmbeddings(true);
    expect(AIService.isSyncing).toBe(false);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(
      'ai_processing_status',
      expect.objectContaining({ isProcessing: false })
    );
  });
});
