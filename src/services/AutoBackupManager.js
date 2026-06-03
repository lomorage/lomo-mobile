import { DeviceEventEmitter, AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import UploadService from './UploadService';
import GalleryStore from '../store/GalleryStore';

export const BACKGROUND_BACKUP_TASK = 'LOMO_BACKUP_TASK';

class AutoBackupManager {
    constructor() {
        this.isBackingUp = false;
        this.queue = [];
        this.currentIndex = 0;
        this.isPaused = false;
        this.pauseReason = null;   // human-readable reason shown in UI
        this.autoBackupEnabled = true;
        this.wifiOnlyBackup = true;
        this.chargingOnlyBackup = false;
        this.nightBackupOnly = false;
        this.consecutiveErrors = 0;
        this.retryCount = 0;       // for exponential backoff
        this.retryMessage = null;  // user-friendly retry message
        this._retryTimer = null;   // pending backoff timer

        this.initSettings();
        
        DeviceEventEmitter.addListener('settingsChanged', (settings) => {
            if (settings.autoBackupEnabled !== undefined) {
                this.autoBackupEnabled = settings.autoBackupEnabled;
            }
            if (settings.wifiOnlyBackup !== undefined) {
                this.wifiOnlyBackup = settings.wifiOnlyBackup;
            }
            if (settings.chargingOnlyBackup !== undefined) {
                this.chargingOnlyBackup = settings.chargingOnlyBackup;
            }
            if (settings.nightBackupOnly !== undefined) {
                this.nightBackupOnly = settings.nightBackupOnly;
            }
            if (!this.autoBackupEnabled) {
                this.pause();
                this.queue = [];
                this.emitState();
            } else if (!this.isBackingUp && !this.isPaused) {
                this.syncQueueWithGallery();
            }
            this.updateNotification();
        });

        // Plug-in auto-wake listener: Resume backup when charger connects
        try {
            Battery.addBatteryStateListener(({ batteryState }) => {
                const isCharging = 
                    batteryState === Battery.BatteryState.CHARGING || 
                    batteryState === Battery.BatteryState.FULL;
                if (this.chargingOnlyBackup && isCharging && this.isPaused) {
                    console.log('[AutoBackupManager] Power connected. Auto-resuming backup.');
                    this.resume();
                }
            });
        } catch (e) {
            console.warn('[AutoBackupManager] Failed to add battery state listener:', e);
        }

        // Note: We no longer listen to AppState changes here. 
        // HomeScreen manages foregrounding and will call syncQueueWithGallery() 
        // ONLY after the efficient Merkle Tree deep-sync is complete.

        this.updateNotification();
    }

    async updateNotification() {
        const total = this.queue.length;
        const current = this.currentIndex + 1;

        if (!this.autoBackupEnabled || this.isPaused || total === 0) {
            // Dismiss Android sticky notification
            if (Platform.OS === 'android') {
                await Notifications.dismissAllNotificationsAsync().catch(() => {});
            }
            // Hide iOS in-app banner
            DeviceEventEmitter.emit('syncNotification', null);
            return;
        }

        // Throttle updates: only emit every 10 items or on final item
        if (current % 10 !== 1 && current !== total && this.isBackingUp) {
            return;
        }

        const message = `Backing up ${current} of ${total} photos...`;

        if (Platform.OS === 'android') {
            // Android: persistent system notification
            try {
                const { status } = await Notifications.getPermissionsAsync();
                if (status !== 'granted') {
                    await Notifications.requestPermissionsAsync();
                }
                await Notifications.setNotificationHandler({
                    handleNotification: async () => ({
                        shouldShowAlert: false,
                        shouldPlaySound: false,
                        shouldSetBadge: false,
                    }),
                });
                await Notifications.scheduleNotificationAsync({
                    identifier: 'LOMO_BACKUP_STATUS',
                    content: {
                        title: 'Lomorage Background Sync',
                        body: message,
                        android: {
                            sticky: true,
                            ongoing: true,
                            priority: 'low',
                            category: 'service',
                            color: '#007AFF',
                        },
                    },
                    trigger: null,
                });
            } catch (e) {
                console.error('[AutoBackupManager] Notification error:', e);
            }
        } else {
            // iOS: emit an in-app banner event — HomeScreen listens and shows a banner
            DeviceEventEmitter.emit('syncNotification', {
                message,
                current,
                total,
                isPaused: this.isPaused,
            });
        }
    }

    async registerBackgroundTask() {
        try {
            const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_BACKUP_TASK);
            if (!isRegistered) {
                await BackgroundTask.registerTaskAsync(BACKGROUND_BACKUP_TASK, {
                    minimumInterval: 15 * 60, // 15 minutes
                    stopOnTerminate: false,
                    startOnBoot: true,
                });
                console.log('[AutoBackupManager] Background task registered.');
            } else {
                console.log('[AutoBackupManager] Background task already registered.');
            }
        } catch (e) {
            console.error('[AutoBackupManager] Failed to register background task:', e);
        }
    }

    async initSettings() {
        try {
            const savedAutoBackup = await SecureStore.getItemAsync('lomorage_auto_backup');
            if (savedAutoBackup !== null) this.autoBackupEnabled = savedAutoBackup === 'true';
            
            const savedWifiOnly = await SecureStore.getItemAsync('lomorage_wifi_only');
            if (savedWifiOnly !== null) this.wifiOnlyBackup = savedWifiOnly === 'true';

            const savedChargingOnly = await SecureStore.getItemAsync('lomorage_charging_only');
            if (savedChargingOnly !== null) this.chargingOnlyBackup = savedChargingOnly === 'true';

            const savedNightBackup = await SecureStore.getItemAsync('lomorage_night_backup');
            if (savedNightBackup !== null) this.nightBackupOnly = savedNightBackup === 'true';

            // P0 Fix: persist isPaused so background task respects user's manual pause
            const savedIsPaused = await SecureStore.getItemAsync('lomorage_is_paused');
            if (savedIsPaused === 'true') {
                this.isPaused = true;
                this.pauseReason = await SecureStore.getItemAsync('lomorage_pause_reason') || 'Paused';
            }
        } catch(e) {}
    }

    // Called whenever the gallery is updated
    syncQueueWithGallery() {
        if (!this.autoBackupEnabled) return;

        const assets = GalleryStore.getAssets();
        // Only queue assets that are strictly 'local'
        const pendingAssets = assets.filter(a => a.status === 'local');
        
        // Update queue, trying to preserve order if possible or just reset
        if (!this.isBackingUp) {
            this.queue = pendingAssets;
            this.currentIndex = 0;
            if (this.queue.length > 0 && !this.isPaused) {
                this.startBackup();
            }
        } else {
            // If already backing up, we might just append missing ones, 
            // but for simplicity we let the current run finish and it will re-evaluate.
            // Or we can dynamically update the queue length.
            const currentlyUploadingId = this.queue[this.currentIndex]?.id;
            this.queue = pendingAssets;
            // Find the new index of the currently uploading item to maintain sanity
            const newIndex = this.queue.findIndex(a => a.id === currentlyUploadingId);
            this.currentIndex = newIndex !== -1 ? newIndex : 0;
        }

        this.emitState();
    }

    async isWifiConnected() {
        try {
            const state = await Network.getNetworkStateAsync();
            return (
                state.isConnected &&
                state.type === Network.NetworkStateType.WIFI
            );
        } catch (e) {
            console.warn('[AutoBackupManager] Network check failed, assuming Wi-Fi:', e);
            return true; // Fail open: allow upload if we can't determine state
        }
    }

    async isDeviceCharging() {
        try {
            const batteryState = await Battery.getBatteryStateAsync();
            return (
                batteryState === Battery.BatteryState.CHARGING ||
                batteryState === Battery.BatteryState.FULL
            );
        } catch (e) {
            console.warn('[AutoBackupManager] Battery check failed, assuming charging:', e);
            return true; // Fail open
        }
    }

    isNightTime() {
        const hour = new Date().getHours();
        return hour >= 2 && hour < 5; // Between 2 AM and 5 AM
    }

    async startBackup() {
        if (this.isBackingUp || this.queue.length === 0 || this.isPaused) return;
        this.isBackingUp = true;
        this.emitState();

        while (this.currentIndex < this.queue.length && !this.isPaused) {
            const asset = this.queue[this.currentIndex];

            // Wi-Fi-only enforcement: pause upload if disconnected from Wi-Fi
            if (this.wifiOnlyBackup) {
                const onWifi = await this.isWifiConnected();
                if (!onWifi) {
                    console.log('[AutoBackupManager] Wi-Fi-only mode enabled and not on Wi-Fi. Pausing backup.');
                    this.pause('Not connected to Wi-Fi');
                    break;
                }
            }

            // Charging-only enforcement: pause upload if disconnected from charger
            if (this.chargingOnlyBackup) {
                const charging = await this.isDeviceCharging();
                if (!charging) {
                    console.log('[AutoBackupManager] Charging-only mode enabled and not charging. Pausing backup.');
                    this.pause('Device is not charging');
                    break;
                }
            }

            // Night-only enforcement: pause upload if outside late-night window
            if (this.nightBackupOnly) {
                const nightTime = this.isNightTime();
                if (!nightTime) {
                    console.log('[AutoBackupManager] Night-only mode enabled and outside backup window. Pausing backup.');
                    this.pause('Outside night backup window (2–5 AM)');
                    break;
                }
            }

            try {
                // If the asset somehow became synced, skip it
                if (asset.status !== 'local') {
                    this.currentIndex++;
                    continue;
                }

                // Call UploadService and pass a progress callback
                const result = await UploadService.uploadAsset(asset, (progress) => {
                    DeviceEventEmitter.emit('backupProgress', {
                        assetId: asset.id,
                        totalCount: this.queue.length,
                        currentIndex: this.currentIndex,
                        progress: progress
                    });
                });

                if (result.success) {
                    // Update global state
                    const updatedAsset = { ...asset, status: 'synced', hash: result.hash };
                    const currentAssets = GalleryStore.getAssets();
                    const newAssets = currentAssets.map(a => a.id === asset.id ? updatedAsset : a);
                    GalleryStore.setAssets(newAssets);
                    
                    // Tell the UI this specific asset finished
                    DeviceEventEmitter.emit('assetUpdated', updatedAsset);
                    this.consecutiveErrors = 0; // Reset on success
                }
            } catch (error) {
                console.error(`[AutoBackup] Failed to backup asset ${asset.id}:`, error);

                // 'different hash' is an iOS data-integrity issue (file transcoded differently).
                // We MUST invalidate the cache and retry immediately with the NEW hash,
                // instead of skipping it silently, because otherwise resumable uploads after app restart
                // will fail permanently if the file size/bytes changed slightly.
                if (error.isDifferentHash) {
                    console.log(`[AutoBackup] Invalidating hash cache for ${asset.id} due to different hash error. Will retry immediately.`);
                    const SyncService = require('./SyncService').default;
                    delete SyncService.localHashCache[asset.id];
                    delete asset.hash;
                    // Do NOT increment currentIndex, so it retries immediately!
                    continue;
                }

                this.consecutiveErrors++;
                this.retryCount++;

                // P1 Fix: Exponential backoff — wait before retrying, pause only after 4 failures
                const backoffDelays = [5000, 30000, 120000]; // 5s, 30s, 2min
                if (this.retryCount <= backoffDelays.length) {
                    const delay = backoffDelays[this.retryCount - 1];
                    console.log(`[AutoBackup] Error #${this.retryCount}, retrying in ${delay/1000}s...`);
                    this.retryMessage = `Connection lost, retrying in ${delay/1000}s...`;
                    this.emitState();
                    await new Promise(resolve => {
                        this._retryTimer = setTimeout(resolve, delay);
                    });
                    this._retryTimer = null;
                    this.retryMessage = null;
                    // Don't increment currentIndex — retry the same asset
                    continue;
                } else {
                    console.log('[AutoBackup] Too many consecutive errors, pausing with backoff exhausted.');
                    this.pause('Connection issues — tap to resume');
                    break;
                }
            }

            this.currentIndex++;
            this.emitState();
            this.updateNotification();
        }

        this.isBackingUp = false;
        this.updateNotification();
        
        // If we finished the sequence but the gallery still has local items (added during backup), restart.
        const remaining = GalleryStore.getAssets().filter(a => a.status === 'local');
        if (remaining.length > 0 && !this.isPaused) {
            this.syncQueueWithGallery();
        } else if (!this.isPaused) {
            this.queue = [];
            this.currentIndex = 0;
            this.emitState();
        } else {
            // If paused, keep the queue intact so the banner correctly displays "Backup Paused"
            this.emitState();
        }
    }

    pause(reason = 'Paused') {
        this.isPaused = true;
        this.pauseReason = reason;
        // P0 Fix: persist pause state so background task respects it
        SecureStore.setItemAsync('lomorage_is_paused', 'true').catch(() => {});
        SecureStore.setItemAsync('lomorage_pause_reason', reason).catch(() => {});
        // Cancel any pending backoff timer
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        
        // ABORT the currently uploading file immediately!
        try {
            const UploadService = require('./UploadService').default;
            const currentAsset = this.queue[this.currentIndex];
            if (currentAsset && currentAsset.id) {
                UploadService.cancelUpload(currentAsset.id);
            }
        } catch (e) {
            console.warn('[AutoBackup] Failed to cancel current upload:', e);
        }

        this.updateNotification();
        this.emitState();
    }

    resume() {
        this.isPaused = false;
        this.pauseReason = null;
        this.consecutiveErrors = 0;
        this.retryCount = 0;
        this.retryMessage = null;
        // P0 Fix: clear persisted pause state
        SecureStore.deleteItemAsync('lomorage_is_paused').catch(() => {});
        SecureStore.deleteItemAsync('lomorage_pause_reason').catch(() => {});
        // Re-evaluate queue and start
        this.syncQueueWithGallery();
        this.updateNotification();
    }

    emitState() {
        DeviceEventEmitter.emit('backupState', {
            isBackingUp: this.isBackingUp,
            isPaused: this.isPaused,
            pauseReason: this.pauseReason,    // P1 Fix: expose reason for UI
            retryCount: this.retryCount,       // expose for UI ("Retrying in Xs...")
            retryMessage: this.retryMessage,
            pendingCount: Math.max(0, this.queue.length - this.currentIndex),
            totalCount: this.queue.length,
            currentAssetId: this.queue[this.currentIndex]?.id || null
        });
    }
}

// Global Task Definition
TaskManager.defineTask(BACKGROUND_BACKUP_TASK, async () => {
    console.log('[BackgroundTask] Checking for new assets in background...');

    // Guard: don't run if the foreground singleton is already actively uploading.
    // Running both concurrently causes UNIQUE constraint races on the server.
    const foregroundManager = require('./AutoBackupManager').default;
    if (foregroundManager && foregroundManager.isBackingUp) {
        console.log('[BackgroundTask] Foreground backup is active, skipping background task.');
        return BackgroundTask.BackgroundTaskResult.Success;
    }

    try {
        const manager = new AutoBackupManager();
        await manager.initSettings();
        
        if (!manager.autoBackupEnabled || manager.isPaused) {
            console.log('[BackgroundTask] Auto-backup disabled or paused, skipping.');
            return BackgroundTask.BackgroundTaskResult.Success;
        }

        // Hydrate SyncService to check what's already on the server!
        // This prevents redundant hashing/processing of items we already know are synced.
        const SyncService = require('./SyncService').default;
        await SyncService.loadRemoteTree();

        const MediaService = require('./MediaService').default;
        let pending = [];
        let hasNextPage = true;
        let after = null;
        let pagesScanned = 0;
        const MAX_PAGES = 5; // Scan up to 500 recent items
        
        console.log('[BackgroundTask] Starting deep scan...');
        // P0 Fix: load localHashCache so we can look up correct hashes
        // (MediaLibrary assets do NOT have a .hash field — that's computed by SyncService)
        await SyncService.loadLocalHashCache();

        while (hasNextPage && pagesScanned < MAX_PAGES) {
            const result = await MediaService.getAssets(100, after);
            const assets = result.assets || [];
            
            for (const asset of assets) {
                // Look up the cached hash we computed during foreground sync
                const cached = SyncService.localHashCache[asset.id];
                const hash = cached?.hash;
                const isSynced = hash && SyncService.remoteTree?.getNodeByHash(hash);
                if (!isSynced) {
                    pending.push(asset);
                }
            }
            
            // Heuristic: If an entire page of assets are all in the cache and synced, stop scanning
            const allSynced = assets.length > 0 && assets.every(a => {
                const h = SyncService.localHashCache[a.id]?.hash;
                return h && SyncService.remoteTree?.getNodeByHash(h);
            });
            if (allSynced) {
                console.log('[BackgroundTask] Found fully-synced boundary, stopping scan.');
                break;
            }
            
            after = result.endCursor;
            hasNextPage = result.hasNextPage;
            pagesScanned++;
        }
        
        if (pending.length > 0) {
            console.log(`[BackgroundTask] Found ${pending.length} pending assets. Starting background upload...`);
            manager.queue = pending;
            await manager.startBackup();
            console.log('[BackgroundTask] Background upload finished.');
            
            // Send iOS local notification upon background sync completion
            if (Platform.OS === 'ios') {
                try {
                    const syncedCount = manager.currentIndex;
                    if (syncedCount > 0) {
                        const { status } = await Notifications.getPermissionsAsync();
                        if (status === 'granted') {
                            await Notifications.scheduleNotificationAsync({
                                content: {
                                    title: 'Lomorage Sync Complete',
                                    body: `Successfully backed up ${syncedCount} new photo${syncedCount > 1 ? 's' : ''} in the background.`,
                                    sound: true,
                                },
                                trigger: null,
                            });
                        }
                    }
                } catch (e) {
                    console.error('[BackgroundTask] iOS notification error:', e);
                }
            }

            // Refresh and save the remote tree to disk so the foreground app has the updated state immediately!
            try {
                await SyncService.fetchRemoteOverview();
                console.log('[BackgroundTask] Updated remote tree cache on disk.');
            } catch (e) {
                console.warn('[BackgroundTask] Failed to update remote tree cache:', e.message);
            }
        } else {
            console.log('[BackgroundTask] No new assets found to upload.');
        }
        
        return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
        console.error('[BackgroundTask] Failed:', error);
        return BackgroundTask.BackgroundTaskResult.Failed;
    }
});

export default new AutoBackupManager();
