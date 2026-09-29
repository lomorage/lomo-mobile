jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DeviceEventEmitter: { emit: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

import { DeviceEventEmitter } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import FirstBackupService, {
  FIRST_BACKUP_CHANGED_EVENT,
  FIRST_BACKUP_COMPLETED_KEY,
  FIRST_BACKUP_PENDING_KEY,
} from '../FirstBackupService';

describe('FirstBackupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks first backup pending after the first successful authentication', async () => {
    SecureStore.getItemAsync.mockResolvedValue(null);

    await expect(FirstBackupService.beginIfNeeded()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(FIRST_BACKUP_PENDING_KEY, 'true');
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(FIRST_BACKUP_CHANGED_EVENT, { pending: true });
  });

  test('does not restart onboarding after the first backup completed', async () => {
    SecureStore.getItemAsync.mockResolvedValue('true');

    await expect(FirstBackupService.beginIfNeeded()).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('persists completion and clears the pending marker', async () => {
    await FirstBackupService.complete();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(FIRST_BACKUP_COMPLETED_KEY, 'true');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(FIRST_BACKUP_PENDING_KEY);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(FIRST_BACKUP_CHANGED_EVENT, { pending: false });
  });
});
