import * as SecureStore from 'expo-secure-store';

// When a backup last uploaded something, for "Last backup: today at 12:22" in Backup Status.
const LAST_BACKUP_KEY = 'lomorage_last_backup_at';

export async function setLastBackupAt(time = Date.now()) {
  try {
    await SecureStore.setItemAsync(LAST_BACKUP_KEY, String(time));
  } catch (e) {
    console.warn('[backupHistory] Failed to save last backup time:', e.message);
  }
}

export async function getLastBackupAt() {
  try {
    const value = await SecureStore.getItemAsync(LAST_BACKUP_KEY);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}
