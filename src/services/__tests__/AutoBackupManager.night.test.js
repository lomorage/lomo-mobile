import AutoBackupManager from '../AutoBackupManager';
import GalleryStore from '../../store/GalleryStore';
import UploadService from '../UploadService';
import * as Battery from 'expo-battery';

// Mock react-native
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

// Mock expo-battery
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1.0),
  getBatteryStateAsync: jest.fn(),
  addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
  BatteryState: {
    UNPLUGGED: 'UNPLUGGED',
    CHARGING: 'CHARGING',
    FULL: 'FULL',
    UNKNOWN: 'UNKNOWN'
  }
}));

// Mock secure store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

// Mock network
jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(() => Promise.resolve({
    isConnected: true,
    type: 'WIFI'
  })),
  NetworkStateType: { WIFI: 'WIFI' }
}));

// Mock other expo features
jest.mock('expo-notifications', () => ({
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve()),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  setNotificationHandler: jest.fn(),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../UploadService', () => ({
  uploadAsset: jest.fn(),
}));

describe('AutoBackupManager Scheduling and Constraints', () => {
  const mockAssets = [
    { id: '1', status: 'local', hash: 'h1', uri: 'file:///1.jpg' }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    AutoBackupManager.isPaused = false;
    AutoBackupManager.isBackingUp = false;
    AutoBackupManager.currentIndex = 0;
    AutoBackupManager.queue = [];
    AutoBackupManager.consecutiveErrors = 0;
    AutoBackupManager.chargingOnlyBackup = false;
    AutoBackupManager.nightBackupOnly = false;
    AutoBackupManager.wifiOnlyBackup = false; // Disable wifi constraint for simple battery/time testing
    GalleryStore.setAssets([]);
    UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'h1_synced' });
  });

  describe('isDeviceCharging', () => {
    test('returns true when battery state is CHARGING', async () => {
      Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);
      const charging = await AutoBackupManager.isDeviceCharging();
      expect(charging).toBe(true);
    });

    test('returns true when battery state is FULL', async () => {
      Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.FULL);
      const charging = await AutoBackupManager.isDeviceCharging();
      expect(charging).toBe(true);
    });

    test('returns false when battery state is UNPLUGGED', async () => {
      Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.UNPLUGGED);
      const charging = await AutoBackupManager.isDeviceCharging();
      expect(charging).toBe(false);
    });
  });

  describe('isNightTime', () => {
    let getHoursSpy;

    beforeEach(() => {
      getHoursSpy = jest.spyOn(Date.prototype, 'getHours');
    });

    afterEach(() => {
      getHoursSpy.mockRestore();
    });

    test('returns true during night hours (2 AM to 5 AM)', () => {
      getHoursSpy.mockReturnValue(3); // 3 AM
      expect(AutoBackupManager.isNightTime()).toBe(true);
    });

    test('returns false during daytime hours (e.g. 10 AM, 1 PM)', () => {
      getHoursSpy.mockReturnValue(13); // 1 PM
      expect(AutoBackupManager.isNightTime()).toBe(false);
    });
  });

  describe('startBackup Constraints', () => {
    let getHoursSpy;

    beforeEach(() => {
      getHoursSpy = jest.spyOn(Date.prototype, 'getHours');
    });

    afterEach(() => {
      getHoursSpy.mockRestore();
    });

    test('pauses backup if chargingOnlyBackup is true and device is unplugged', async () => {
      AutoBackupManager.chargingOnlyBackup = true;
      Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.UNPLUGGED);

      AutoBackupManager.queue = mockAssets;
      AutoBackupManager.currentIndex = 0;

      await AutoBackupManager.startBackup();

      // Should pause immediately and NOT call UploadService
      expect(AutoBackupManager.isPaused).toBe(true);
      expect(UploadService.uploadAsset).not.toHaveBeenCalled();
    });

    test('performs backup if chargingOnlyBackup is true and device is charging', async () => {
      AutoBackupManager.chargingOnlyBackup = true;
      Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);

      AutoBackupManager.queue = mockAssets;
      AutoBackupManager.currentIndex = 0;

      await AutoBackupManager.startBackup();

      // Should perform upload successfully
      expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
      expect(AutoBackupManager.isPaused).toBe(false);
    });

    test('pauses backup if nightBackupOnly is true and current time is daytime', async () => {
      AutoBackupManager.nightBackupOnly = true;
      getHoursSpy.mockReturnValue(12); // Noon

      AutoBackupManager.queue = mockAssets;
      AutoBackupManager.currentIndex = 0;

      await AutoBackupManager.startBackup();

      // Should pause immediately and NOT call UploadService
      expect(AutoBackupManager.isPaused).toBe(true);
      expect(UploadService.uploadAsset).not.toHaveBeenCalled();
    });

    test('performs backup if nightBackupOnly is true and current time is between 2 AM and 5 AM', async () => {
      AutoBackupManager.nightBackupOnly = true;
      getHoursSpy.mockReturnValue(4); // 4 AM

      AutoBackupManager.queue = mockAssets;
      AutoBackupManager.currentIndex = 0;

      await AutoBackupManager.startBackup();

      // Should perform upload successfully
      expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
      expect(AutoBackupManager.isPaused).toBe(false);
    });
  });
});
