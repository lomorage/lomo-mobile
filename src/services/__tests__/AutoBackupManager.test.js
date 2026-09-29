import AutoBackupManager from '../AutoBackupManager';
import GalleryStore from '../../store/GalleryStore';
import UploadService from '../UploadService';
import FirstBackupService from '../FirstBackupService';
import { startKeepAlive } from '../../../modules/expo-background-keepalive';

// Mock dependencies
jest.mock('react-native', () => {
  const listeners = {};
  return {
    Platform: { OS: 'ios' },
    DeviceEventEmitter: {
      addListener: jest.fn((event, callback) => {
        listeners[event] = callback;
        return { remove: jest.fn() };
      }),
      emit: jest.fn(),
      // Helper for testing
      _trigger: (event, data) => {
        if (listeners[event]) listeners[event](data);
      }
    },
    AppState: {
      addEventListener: jest.fn(),
      currentState: 'active',
    }
  };
});

jest.mock('expo-notifications', () => ({
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve()),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  setNotificationHandler: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1.0),
  getBatteryStateAsync: jest.fn(() => Promise.resolve('CHARGING')),
  addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
  BatteryState: {
    UNPLUGGED: 'UNPLUGGED',
    CHARGING: 'CHARGING',
    FULL: 'FULL',
    UNKNOWN: 'UNKNOWN'
  }
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(() => Promise.resolve({
    isConnected: true,
    type: 'WIFI'
  })),
  NetworkStateType: { WIFI: 'WIFI' }
}));

jest.mock('../UploadService', () => ({
  uploadAsset: jest.fn(),
}));

jest.mock('../../../modules/expo-background-keepalive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));

describe('AutoBackupManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AutoBackupManager.isPaused = false;
    AutoBackupManager.isBackingUp = false;
    AutoBackupManager.currentIndex = 0;
    AutoBackupManager.queue = [];
    AutoBackupManager.consecutiveErrors = 0;
    AutoBackupManager.firstBackupPending = false;
    GalleryStore.setAssets([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('successfully processes queue, skipping already synced/non-local assets without hanging', async () => {
    const assets = [
      { id: '1', status: 'synced', hash: 'h1' }, // Should be skipped
      { id: '2', status: 'local', hash: 'h2' },   // Should be processed and uploaded
      { id: '3', status: 'synced', hash: 'h3' }, // Should be skipped
    ];
    
    // Configure UploadService mock
    UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'h2_synced' });

    // Set queue directly and start backup
    AutoBackupManager.queue = assets;
    AutoBackupManager.currentIndex = 0;

    await AutoBackupManager.startBackup();

    // Verify it reached the end of the queue
    expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
    expect(UploadService.uploadAsset).toHaveBeenCalledWith(assets[1], expect.any(Function));
  });

  test('uses iOS keep-alive automatically during the first backup', async () => {
    const asset = { id: 'first', status: 'local', hash: 'first-hash' };
    UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'first-hash' });
    AutoBackupManager.firstBackupPending = true;
    AutoBackupManager.queue = [asset];

    await AutoBackupManager.startBackup();

    expect(startKeepAlive).toHaveBeenCalledTimes(1);
  });

  test('refreshes the persisted first-backup flag before a session starts', async () => {
    const asset = { id: 'first', status: 'local', hash: 'first-hash' };
    UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'first-hash' });
    jest.spyOn(FirstBackupService, 'isPending').mockResolvedValue(true);
    AutoBackupManager.queue = [asset];

    await AutoBackupManager.startBackup();

    expect(FirstBackupService.isPending).toHaveBeenCalled();
    expect(startKeepAlive).toHaveBeenCalledTimes(1);
  });
});
