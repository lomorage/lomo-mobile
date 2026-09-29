import { DeviceEventEmitter, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const FIRST_BACKUP_PENDING_KEY = 'lomorage_first_backup_pending';
export const FIRST_BACKUP_COMPLETED_KEY = 'lomorage_first_backup_completed';
export const FIRST_BACKUP_CHANGED_EVENT = 'firstBackupGuideChanged';

class FirstBackupService {
  async beginIfNeeded() {
    if (Platform.OS !== 'ios') return false;

    const completed = await SecureStore.getItemAsync(FIRST_BACKUP_COMPLETED_KEY);
    if (completed === 'true') return false;

    await SecureStore.setItemAsync(FIRST_BACKUP_PENDING_KEY, 'true');
    DeviceEventEmitter.emit(FIRST_BACKUP_CHANGED_EVENT, { pending: true });
    return true;
  }

  async isPending() {
    if (Platform.OS !== 'ios') return false;

    const [pending, completed] = await Promise.all([
      SecureStore.getItemAsync(FIRST_BACKUP_PENDING_KEY),
      SecureStore.getItemAsync(FIRST_BACKUP_COMPLETED_KEY),
    ]);
    return pending === 'true' && completed !== 'true';
  }

  async complete() {
    await SecureStore.setItemAsync(FIRST_BACKUP_COMPLETED_KEY, 'true');
    await SecureStore.deleteItemAsync(FIRST_BACKUP_PENDING_KEY);
    DeviceEventEmitter.emit(FIRST_BACKUP_CHANGED_EVENT, { pending: false });
  }
}

export default new FirstBackupService();
