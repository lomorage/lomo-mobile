import { DeviceEventEmitter } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import UploadService from './UploadService';
import GalleryStore from '../store/GalleryStore';

class AutoBackupManager {
    constructor() {
        this.isBackingUp = false;
        this.queue = [];
        this.currentIndex = 0;
        this.isPaused = false;
        this.autoBackupEnabled = true;
        this.wifiOnlyBackup = true;
        this.consecutiveErrors = 0;

        this.initSettings();
        
        DeviceEventEmitter.addListener('settingsChanged', (settings) => {
            if (settings.autoBackupEnabled !== undefined) {
                this.autoBackupEnabled = settings.autoBackupEnabled;
            }
            if (settings.wifiOnlyBackup !== undefined) {
                this.wifiOnlyBackup = settings.wifiOnlyBackup;
            }
            if (!this.autoBackupEnabled) {
                this.pause();
                this.queue = [];
                this.emitState();
            } else if (!this.isBackingUp && !this.isPaused) {
                this.syncQueueWithGallery();
            }
        });
    }

    async initSettings() {
        try {
            const savedAutoBackup = await SecureStore.getItemAsync('lomorage_auto_backup');
            if (savedAutoBackup !== null) this.autoBackupEnabled = savedAutoBackup === 'true';
            
            const savedWifiOnly = await SecureStore.getItemAsync('lomorage_wifi_only');
            if (savedWifiOnly !== null) this.wifiOnlyBackup = savedWifiOnly === 'true';
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

    async startBackup() {
        if (this.isBackingUp || this.queue.length === 0 || this.isPaused) return;
        this.isBackingUp = true;
        this.emitState();

        while (this.currentIndex < this.queue.length && !this.isPaused) {
            const asset = this.queue[this.currentIndex];
            
            try {
                // If the asset somehow became synced, skip it
                if (asset.status !== 'local') {
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
                this.consecutiveErrors++;
                
                // If we hit 3 consecutive failures, something is wrong with the network.
                // Pause automatically to save battery and avoid spamming error popups.
                if (this.consecutiveErrors >= 3) {
                    console.log('[AutoBackup] Too many consecutive errors, pausing.');
                    this.pause();
                    DeviceEventEmitter.emit('backupError', 'Backup paused due to persistent connection issues.');
                    break; // Exit the loop
                }
            }

            this.currentIndex++;
            this.emitState();
        }

        this.isBackingUp = false;
        
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

    pause() {
        this.isPaused = true;
        this.emitState();
    }

    resume() {
        this.isPaused = false;
        // Re-evaluate queue and start
        this.syncQueueWithGallery();
    }

    emitState() {
        DeviceEventEmitter.emit('backupState', {
            isBackingUp: this.isBackingUp,
            isPaused: this.isPaused,
            pendingCount: Math.max(0, this.queue.length - this.currentIndex),
            totalCount: this.queue.length,
            currentAssetId: this.queue[this.currentIndex]?.id || null
        });
    }
}

export default new AutoBackupManager();
