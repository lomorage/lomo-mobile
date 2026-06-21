import { Platform, AppState, DeviceEventEmitter } from 'react-native';
import axios from 'axios';
import * as ExpoLomoHasher from '../../modules/expo-lomo-hasher';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import AssetDBService from './AssetDBService';
import AuthService from './AuthService';
import MediaService from './MediaService';
import TaskSchedulerService from './TaskSchedulerService';

export const BACKGROUND_AI_SYNC_TASK = 'LOMO_AI_SYNC_TASK';

// Base64 helper to convert base64 string to Float32Array
function base64ToFloat32Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}
// Local translation dictionary to bypass network requests for common search keywords
const LOCAL_TRANSLATION_DICT = {
  '猫': 'cat', '猫咪': 'cat', '小猫': 'cat',
  '狗': 'dog', '狗狗': 'dog', '小狗': 'dog',
  '海滩': 'beach', '沙滩': 'beach', '海边': 'beach',
  '食物': 'food', '美食': 'food', '吃': 'food', '菜': 'food',
  '风景': 'scenery', '风景照': 'scenery', '山水': 'scenery',
  '花': 'flower', '花卉': 'flower', '鲜花': 'flower',
  '截图': 'screenshot', '屏幕截图': 'screenshot',
  '汽车': 'car', '车': 'car', '小汽车': 'car',
  '宝宝': 'baby', '婴儿': 'baby', '小孩': 'baby', '孩子': 'baby',
  '森林': 'forest', '树木': 'forest', '树': 'forest',
  '雪山': 'snow mountain', '雪': 'snow', '下雪': 'snow',
  '夜景': 'night view', '晚上': 'night', '夜里': 'night',
  '建筑': 'building', '房子': 'building', '大楼': 'building',
  '咖啡': 'coffee', '下午茶': 'coffee',
  '自行车': 'bicycle', '单车': 'bicycle', '脚踏车': 'bicycle',
  '运动': 'sports', '健身': 'sports', '跑步': 'sports',
  '旅行': 'travel', '旅游': 'travel', '游玩': 'travel',
  '海洋': 'ocean', '大海': 'ocean', '海': 'ocean',
  '红叶': 'autumn leaves', '枫叶': 'autumn leaves', '秋天': 'autumn',
  '音乐': 'music', '乐器': 'music',
  '人': 'person', '人们': 'people', '大家': 'people',
  '女人': 'woman', '女生': 'woman', '男人': 'man', '男生': 'man',
  '天空': 'sky', '云': 'cloud', '蓝天': 'sky',
  '水': 'water', '河流': 'river', '江河': 'river', '湖泊': 'river',
  '草地': 'grassland', '草': 'grass', '绿草': 'grass',
  '电脑': 'computer', '手机': 'phone', '数码': 'digital',
  '书': 'book', '阅读': 'book', '书籍': 'book'
};
class AIService {
  constructor() {
    this.isProcessing = false;
    this.isSyncing = false;
    this.vectorCache = new Map(); // id -> Float32Array
    this.status = { isProcessing: false, current: 0, total: 0, message: 'Idle' };
    this.isPHashClearedInMemory = false;
    this.isCLIPClearedInMemory = false;
    this.duplicateGroupsCache = null;
    this.duplicateGroupsCacheTime = 0;
  }

  clearDuplicateCache() {
    this.duplicateGroupsCache = null;
    this.duplicateGroupsCacheTime = 0;
  }

  removeDuplicateGroupFromCache(assetIds) {
    if (!this.duplicateGroupsCache) return;
    const idsSet = new Set(assetIds);
    this.duplicateGroupsCache = this.duplicateGroupsCache.filter(group => {
      // If the first item of the group is in the ignored set, remove the entire group from cache
      return !idsSet.has(group[0]?.id);
    });
  }

  getProcessingStatus() {
    return this.status;
  }

  // Check if device is connected to Wi-Fi and charging based on settings constraints
  async isIdleForAI() {
    try {
      const savedAiWifiOnly = await SecureStore.getItemAsync('lomorage_ai_wifi_only');
      const aiWifiOnly = savedAiWifiOnly !== 'false'; // default to true
      
      const savedAiChargingOnly = await SecureStore.getItemAsync('lomorage_ai_charging_only');
      const aiChargingOnly = savedAiChargingOnly !== 'false'; // default to true

      const netState = await Network.getNetworkStateAsync();
      const isWifi = netState.type === Network.NetworkStateType.WIFI;

      const battState = await Battery.getBatteryStateAsync();
      const isCharging = battState === Battery.BatteryState.CHARGING || battState === Battery.BatteryState.FULL;

      const wifiPass = !aiWifiOnly || isWifi;
      const chargingPass = !aiChargingOnly || isCharging;

      return wifiPass && chargingPass;
    } catch (e) {
      console.warn('[AIService] Failed to check Wi-Fi/Charging status, assuming not idle:', e);
      return false;
    }
  }

  // Generate vector from text
  async getTextEmbedding(text) {
    try {
      const base64 = await ExpoLomoHasher.encodeTextEmbeddingAsync(
        text,
        'textual_quant.onnx',
        'vocab.json',
        'merges.txt'
      );
      return base64ToFloat32Array(base64);
    } catch (error) {
      console.error('[AIService] Failed to get text embedding:', error);
      throw error;
    }
  }

  // Check if conditions are met for aggressive background indexing
  async isIdleForAI() {
    try {
      const batteryLevel = await Battery.getBatteryLevelAsync();
      const batteryState = await Battery.getBatteryStateAsync();
      const isCharging = batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL;
      
      // If battery is above 30%, we don't strictly require it to be charging.
      // If battery is below 30%, it MUST be charging to run heavy background tasks.
      const hasEnoughBattery = batteryLevel > 0.3 || isCharging;
      
      const network = await Network.getNetworkStateAsync();
      const isWifi = network.type === Network.NetworkStateType.WIFI;

      return hasEnoughBattery && isWifi;
    } catch (e) {
      return false;
    }
  }

  // Register the OS-level background fetch task
  async registerBackgroundSync() {
    if (Platform.OS === 'web') return;
    try {
      const status = await BackgroundTask.getStatusAsync();
      if (status === BackgroundTask.BackgroundTaskStatus.Restricted || status === BackgroundTask.BackgroundTaskStatus.Denied) {
        console.log('[AIService] Background sync registration denied by user.');
        return;
      }

      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_AI_SYNC_TASK);
      if (!isRegistered) {
        await BackgroundTask.registerTaskAsync(BACKGROUND_AI_SYNC_TASK, {
          minimumInterval: 3600, // 1 hour
          stopOnTerminate: false,
          startOnBoot: true,
        });
        console.log('[AIService] Background AI sync task registered successfully.');
      }
    } catch (e) {
      console.warn('[AIService] Failed to register background AI sync task:', e.message);
    }
  }

  async unregisterBackgroundSync() {
    if (Platform.OS === 'web') return;
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_AI_SYNC_TASK);
      if (isRegistered) {
        await BackgroundTask.unregisterTaskAsync(BACKGROUND_AI_SYNC_TASK);
        console.log('[AIService] Background AI sync task unregistered.');
      }
    } catch (e) {
      console.warn('[AIService] Failed to unregister background AI sync task:', e.message);
    }
  }

  // Generate vector from local image asset
  async getImageEmbedding(imageUri) {
    try {
      return await ExpoLomoHasher.encodeImageEmbeddingAsync(imageUri, 'visual_quant.onnx');
    } catch (error) {
      console.error('[AIService] Failed to get image embedding:', error);
      throw error;
    }
  }

  // 1. Local extraction loop: processes local assets that don't have embeddings yet
  // 1. Local extraction loop: processes local assets that don't have embeddings or phash yet in non-blocking batches
  async processLocalEmbeddings(limit = 10, force = false) {
    if (this.isProcessing) return;

    const savedAiEnabled = await SecureStore.getItemAsync('lomorage_ai_enabled');
    const aiEnabled = savedAiEnabled !== 'false';
    if (!aiEnabled && !force) {
      console.log('[AIService] Skip background local indexing: AI features disabled.');
      return;
    }

    if (!force) {
      const isIdle = await this.isIdleForAI();
      if (!isIdle) {
        console.log('[AIService] Skip background local indexing: device is not charging or not on Wi-Fi.');
        return;
      }
    }

    this.isProcessing = true;
    this.status = { isProcessing: true, current: 0, total: 0, message: 'Analyzing local library...' };
    DeviceEventEmitter.emit('ai_processing_status', this.status);
    console.log('[AIService] Starting local embeddings & phash processing...');

    try {
      const db = AssetDBService.db;
      if (!db) return;

      // Query total pending photos
      const totalRow = await db.getFirstAsync(`
        SELECT COUNT(*) as count 
        FROM MediaAsset 
        WHERE isLocal = 1 
          AND mediaType = "photo" 
          AND ((clipEmbeddingVersion IS NULL OR clipEmbeddingVersion < 1) OR (phash IS NULL OR phash = ""))
      `);
      const total = totalRow?.count || 0;
      let processed = 0;

      this.status = {
        isProcessing: true,
        current: 0,
        total,
        message: total > 0 ? `Analyzing photos (0/${total})...` : 'Indexing finished'
      };
      DeviceEventEmitter.emit('ai_processing_status', this.status);

      let hasMore = true;
      while (hasMore) {
        // Yield to user interactions
        await TaskSchedulerService.waitUntilIdle();

        // Double check AI enabled switch inside loop to halt immediately if turned off
        const currentAiEnabled = (await SecureStore.getItemAsync('lomorage_ai_enabled')) !== 'false';
        if (!currentAiEnabled && !force) {
          console.log('[AIService] AI disabled during processing. Halting.');
          hasMore = false;
          break;
        }

        const pending = await db.getAllAsync(`
          SELECT id, hash, clipEmbeddingVersion, phash 
          FROM MediaAsset 
          WHERE isLocal = 1 
            AND mediaType = "photo" 
            AND ((clipEmbeddingVersion IS NULL OR clipEmbeddingVersion < 1) OR (phash IS NULL OR phash = ""))
          LIMIT ?
        `, [limit]);

        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`[AIService] Processing batch of ${pending.length} local photos for embedding & phash...`);
        let didCalculateEmbeddingInBatch = false;

        for (const asset of pending) {
          let didCalculateEmbeddingForAsset = false;
          try {
            processed++;
            this.status = {
              isProcessing: true,
              current: Math.min(processed, total),
              total,
              message: `Analyzing photos (${Math.min(processed, total)}/${total})...`
            };
            DeviceEventEmitter.emit('ai_processing_status', this.status);

            console.log(`[AIService] Processing features for local asset ${asset.id}...`);
            let localPath = null;
            try {
              const info = await MediaService.getAssetInfo(asset.id);
              localPath = info?.localUri || info?.uri;
            } catch (e) {
              console.warn(`[AIService] Failed to get asset info for ${asset.id}:`, e.message);
            }

            if (!localPath && Platform.OS === 'android') {
              localPath = `content://media/external/images/media/${asset.id}`;
            }

            if (!localPath) {
              throw new Error(`Could not resolve local path for asset ${asset.id}`);
            }

            // A. Calculate clipEmbedding if missing
            if (!asset.clipEmbeddingVersion || asset.clipEmbeddingVersion < 1) {
              const base64 = await this.getImageEmbedding(localPath);
              await this.saveAssetEmbedding(asset.id, base64, 1);
              console.log(`[AIService] Saved embedding locally for asset ${asset.id}.`);
              didCalculateEmbeddingForAsset = true;
              didCalculateEmbeddingInBatch = true;
            }

            // B. Calculate phash if missing
            if (!asset.phash || asset.phash === "") {
              try {
                const phash = await ExpoLomoHasher.generatePHashAsync(localPath);
                if (phash && phash !== "0") {
                  await this.saveAssetPHash(asset.id, phash);
                  console.log(`[AIService] Saved phash ${phash} locally for asset ${asset.id}.`);
                }
              } catch (pe) {
                console.warn(`[AIService] Failed to calculate phash for local asset ${asset.id}:`, pe.message);
              }
            }
          } catch (err) {
            console.warn(`[AIService] Failed to process asset ${asset.id}:`, err.message);
            if (!asset.clipEmbeddingVersion || asset.clipEmbeddingVersion < 1) {
              await this.saveAssetEmbedding(asset.id, 'failed', -1);
            }
            if (!asset.phash || asset.phash === "") {
              await this.saveAssetPHash(asset.id, 'failed');
            }
          }

          // Throttle background task processing ONLY when a heavy embedding model was called and app is active
          if (didCalculateEmbeddingForAsset && AppState.currentState === 'active') {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
        // Yield to the JS thread to keep the UI smooth (longer yield if heavy embedding was run in this batch)
        const sleepDelay = (AppState.currentState === 'active' && didCalculateEmbeddingInBatch) ? 3000 : 100;
        await new Promise(resolve => setTimeout(resolve, sleepDelay));
      }
    } catch (error) {
      console.error('[AIService] Error in processLocalEmbeddings:', error);
    } finally {
      this.isProcessing = false;
      this.status = { isProcessing: false, current: 0, total: 0, message: 'Idle' };
      DeviceEventEmitter.emit('ai_processing_status', this.status);
      console.log('[AIService] Local features processing finished.');
    }
  }

  // Helper to update embedding in SQLite and cache in memory
  async saveAssetEmbedding(idOrHash, embeddingBase64, version = 1) {
    const db = AssetDBService.db;
    if (!db) return;
    await db.runAsync(
      'UPDATE MediaAsset SET clipEmbedding = ?, clipEmbeddingVersion = ? WHERE id = ? OR hash = ?',
      [embeddingBase64, version, idOrHash, idOrHash]
    );
    
    // Sync with in-memory cache
    if (embeddingBase64 && embeddingBase64 !== 'failed' && embeddingBase64 !== 'none') {
      try {
        const row = await db.getFirstAsync('SELECT id FROM MediaAsset WHERE id = ? OR hash = ?', [idOrHash, idOrHash]);
        if (row && row.id) {
          this.vectorCache.set(row.id, base64ToFloat32Array(embeddingBase64));
        }
      } catch (e) {
        console.warn('[AIService] Failed to update vector cache on save:', e);
      }
    } else {
      try {
        const row = await db.getFirstAsync('SELECT id FROM MediaAsset WHERE id = ? OR hash = ?', [idOrHash, idOrHash]);
        if (row && row.id) {
          this.vectorCache.delete(row.id);
        }
      } catch (e) {}
    }
  }

  // Helper to update phash in SQLite
  async saveAssetPHash(idOrHash, phash) {
    const db = AssetDBService.db;
    if (!db) return;
    await db.runAsync(
      'UPDATE MediaAsset SET phash = ? WHERE id = ? OR hash = ?',
      [phash, idOrHash, idOrHash]
    );
  }

  // 2. Synchronize embeddings with lomo-backend
  async syncEmbeddings(force = false) {
    if (this.isSyncing) return;
    const savedAiEnabled = await SecureStore.getItemAsync('lomorage_ai_enabled');
    const aiEnabled = savedAiEnabled !== 'false';
    if (!aiEnabled && !force) {
      console.log('[AIService] Skip embeddings sync: AI features disabled.');
      return;
    }
    this.isSyncing = true;
    console.log('[AIService] Starting embeddings sync...');

    try {
      const url = AuthService.getServerUrl();
      const token = AuthService.getToken();
      if (!url || !token) {
        console.log('[AIService] Sync aborted: server url or token is missing.');
        return;
      }

      const db = AssetDBService.db;
      if (!db) return;

      // Part A: Upload local embeddings to server
      let hasMoreUploads = true;
      const totalUploadsRow = await db.getFirstAsync(`
        SELECT COUNT(*) as count 
        FROM MediaAsset 
        WHERE isLocal = 1 
          AND uploaded = 1 
          AND clipEmbedding IS NOT NULL 
          AND clipEmbedding != "" 
          AND clipEmbedding != "failed" 
          AND hash NOT IN (
            SELECT hash FROM MediaAsset WHERE isLocal = 0 AND clipEmbedding IS NOT NULL AND clipEmbedding != ""
          )
      `);
      const totalUploads = totalUploadsRow?.count || 0;
      let processedUploads = 0;

      while (hasMoreUploads) {
        const localPendingUpload = await db.getAllAsync(`
          SELECT id, hash, clipEmbedding 
          FROM MediaAsset 
          WHERE isLocal = 1 
            AND uploaded = 1 
            AND clipEmbedding IS NOT NULL 
            AND clipEmbedding != "" 
            AND clipEmbedding != "failed" 
            AND hash NOT IN (
              SELECT hash FROM MediaAsset WHERE isLocal = 0 AND clipEmbedding IS NOT NULL AND clipEmbedding != ""
            )
          LIMIT 10
        `);

        if (localPendingUpload.length === 0) {
          hasMoreUploads = false;
          break;
        }

        console.log(`[AIService] Uploading batch of ${localPendingUpload.length} local embeddings to server...`);
        for (const asset of localPendingUpload) {
          try {
            processedUploads++;
            this.status = {
              isProcessing: true,
              current: 0,
              total: 0,
              message: `Uploading photo features (${processedUploads}/${totalUploads})...`
            };
            DeviceEventEmitter.emit('ai_processing_status', this.status);

            const serverAssetId = await this.getServerAssetIdByHash(asset.hash);
            if (!serverAssetId) {
              console.log(`[AIService] Skipping upload for ${asset.hash}: server ID not synced yet.`);
              continue;
            }

            const device = Platform.OS === 'ios' ? 'ios' : 'android';
            const name = 'shared.similarity.clip.embedding';
            
            const payload = [{
              Category: 'similarity',
              SourceDevice: device,
              AssetID: serverAssetId,
              Name: name,
              Value: asset.clipEmbedding,
              Version: 1
            }];

            await axios.post(`${url}/assets/metadata?force=1`, payload, {
              headers: { Authorization: `token=${token}` },
              timeout: 15000
            });
            console.log(`[AIService] Uploaded embedding for server asset ID ${serverAssetId} successfully.`);
            // Mark remote asset representation in SQLite as having the embedding to avoid re-upload loop
            await db.runAsync(
              'INSERT OR IGNORE INTO MediaAsset (id, hash, isLocal) VALUES (?, ?, 0)',
              [asset.hash, asset.hash]
            );
            await this.saveAssetEmbedding(asset.hash, asset.clipEmbedding, 0);
          } catch (e) {
            console.warn(`[AIService] Failed to upload embedding for ${asset.hash}:`, e.message);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Part A2: Upload locally calculated pHashes to server
      const totalPHashUploadsRow = await db.getFirstAsync(`
        SELECT COUNT(*) as count 
        FROM MediaAsset 
        WHERE isLocal = 1 
          AND uploaded = 1 
          AND phash IS NOT NULL 
          AND phash != "" 
          AND phash != "failed" 
          AND phash != "none"
          AND hash IS NOT NULL
          AND hash NOT IN (
            SELECT hash FROM MediaAsset WHERE isLocal = 0 AND phash IS NOT NULL AND phash != ""
          )
      `);
      const totalPHashUploads = totalPHashUploadsRow?.count || 0;
      let processedPHashUploads = 0;
      let hasMorePHashUploads = true;

      while (hasMorePHashUploads) {
        const localPendingPHashUpload = await db.getAllAsync(`
          SELECT id, hash, phash 
          FROM MediaAsset 
          WHERE isLocal = 1 
            AND uploaded = 1 
            AND phash IS NOT NULL 
            AND phash != "" 
            AND phash != "failed" 
            AND phash != "none"
            AND hash NOT IN (
              SELECT hash FROM MediaAsset WHERE isLocal = 0 AND phash IS NOT NULL AND phash != ""
            )
          LIMIT 10
        `);

        if (localPendingPHashUpload.length === 0) {
          hasMorePHashUploads = false;
          break;
        }

        console.log(`[AIService] Uploading batch of ${localPendingPHashUpload.length} local pHashes to server...`);
        for (const asset of localPendingPHashUpload) {
          try {
            processedPHashUploads++;
            this.status = {
              isProcessing: true,
              current: 0,
              total: 0,
              message: `Uploading photo fingerprints (${processedPHashUploads}/${totalPHashUploads})...`
            };
            DeviceEventEmitter.emit('ai_processing_status', this.status);

            const serverAssetId = await this.getServerAssetIdByHash(asset.hash);
            if (!serverAssetId) {
              console.log(`[AIService] Skipping phash upload for ${asset.hash}: server ID not synced yet.`);
              continue;
            }

            const device = Platform.OS === 'ios' ? 'ios' : 'android';
            const name = 'shared.phash.fingerprint';
            
            const payload = [{
              Category: 'similarity',
              SourceDevice: device,
              AssetID: serverAssetId,
              Name: name,
              Value: asset.phash,
              Version: 1
            }];

            await axios.post(`${url}/assets/metadata?force=1`, payload, {
              headers: { Authorization: `token=${token}` },
              timeout: 15000
            });
            console.log(`[AIService] Uploaded phash for server asset ID ${serverAssetId} successfully.`);
            // Mark remote asset representation in SQLite as having the phash to avoid re-upload loop
            await db.runAsync(
              'INSERT OR IGNORE INTO MediaAsset (id, hash, isLocal) VALUES (?, ?, 0)',
              [asset.hash, asset.hash]
            );
            await this.saveAssetPHash(asset.hash, asset.phash);
          } catch (e) {
            console.warn(`[AIService] Failed to upload phash for ${asset.hash}:`, e.message);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Part B: Download remote embeddings and phash from server
      const savedRemoteAI = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
      const remoteAIEnabled = savedRemoteAI !== 'false';
      if (!remoteAIEnabled && !force) {
        console.log('[AIService] Skip remote embedding download: remote AI indexing disabled.');
      } else {
        const totalDownloadRow = await db.getFirstAsync(`
          SELECT COUNT(*) as count 
          FROM MediaAsset 
          WHERE isLocal = 0 
            AND ((clipEmbedding IS NULL OR clipEmbedding = "") OR (phash IS NULL OR phash = ""))
        `);
        const totalDownloads = totalDownloadRow?.count || 0;
        let processedDownloads = 0;

        let hasMoreDownloads = true;
        while (hasMoreDownloads) {
          // Yield to user interactions to prevent scroll stuttering
          await TaskSchedulerService.waitUntilIdle();

          const remotePendingDownload = await db.getAllAsync(`
            SELECT id, hash 
            FROM MediaAsset 
            WHERE isLocal = 0 
              AND ((clipEmbedding IS NULL OR clipEmbedding = "") OR (phash IS NULL OR phash = ""))
            LIMIT 20
          `);

          if (remotePendingDownload.length === 0) {
            hasMoreDownloads = false;
            break;
          }

          console.log(`[AIService] Syncing batch of ${remotePendingDownload.length} remote embeddings & phash from server...`);
          const pHashUpdates = [];
          const embeddingUpdates = [];

          for (const asset of remotePendingDownload) {
            try {
              processedDownloads++;
              this.status = {
                isProcessing: true,
                current: 0,
                total: 0,
                message: `Syncing remote photo features (${Math.min(processedDownloads, totalDownloads)}/${totalDownloads})...`
              };
              DeviceEventEmitter.emit('ai_processing_status', this.status);

              const res = await axios.get(`${url}/asset/metadata/${asset.hash}`, {
                headers: { Authorization: `token=${token}` },
                timeout: 10000,
                skipAutoProbe: true
              });
              const data = res.data;
              let foundEmbedding = false;
              let foundPHash = false;
              let pHashVal = 'none';
              let embeddingVal = 'none';
              
              if (data && data.Metadatas) {
                for (const meta of data.Metadatas) {
                  if (meta.Name === 'shared.phash.fingerprint' || meta.Name === 'ios.phash.fingerprint' || meta.Name === 'android.phash.fingerprint') {
                    if (meta.Value && meta.Value.length > 0) {
                      pHashVal = meta.Value;
                      foundPHash = true;
                    }
                  }
                  if (meta.Name && meta.Name.endsWith('.similarity.clip.embedding')) {
                    if (meta.Value && meta.Value.length > 100) {
                      embeddingVal = meta.Value;
                      foundEmbedding = true;
                    }
                  }
                }
              }

              pHashUpdates.push({ idOrHash: asset.hash, phash: pHashVal });
              embeddingUpdates.push({ idOrHash: asset.hash, embedding: embeddingVal, version: foundEmbedding ? 1 : 1 });
            } catch (e) {
              if (e.response && e.response.status === 404) {
                pHashUpdates.push({ idOrHash: asset.hash, phash: 'none' });
                embeddingUpdates.push({ idOrHash: asset.hash, embedding: 'none', version: 1 });
              } else {
                console.warn(`[AIService] Failed to get metadata for remote asset ${asset.hash}:`, e.message);
              }
            }
          }

          // Execute batch database writes
          if (pHashUpdates.length > 0) {
            await AssetDBService.saveAssetPHashesBatch(pHashUpdates);
          }
          if (embeddingUpdates.length > 0) {
            await AssetDBService.saveAssetEmbeddingsBatch(embeddingUpdates);

            // Sync with in-memory vector cache
            for (const update of embeddingUpdates) {
              if (update.embedding && update.embedding !== 'failed' && update.embedding !== 'none') {
                try {
                  const row = await db.getFirstAsync('SELECT id FROM MediaAsset WHERE id = ? OR hash = ?', [update.idOrHash, update.idOrHash]);
                  if (row && row.id) {
                    this.vectorCache.set(row.id, base64ToFloat32Array(update.embedding));
                  }
                } catch (_) {}
              } else {
                try {
                  const row = await db.getFirstAsync('SELECT id FROM MediaAsset WHERE id = ? OR hash = ?', [update.idOrHash, update.idOrHash]);
                  if (row && row.id) {
                    this.vectorCache.delete(row.id);
                  }
                } catch (_) {}
              }
            }
          }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

        // Part C: Scheme B - Local extraction for remote photos (idle Wi-Fi/Charging only)
        const isIdle = force ? true : await this.isIdleForAI();
        if (!isIdle) {
          console.log('[AIService] Scheme B: Skip remote photos local indexing (device is not charging or not on Wi-Fi).');
        } else {
          const totalRemoteRow = await db.getFirstAsync(`
            SELECT COUNT(*) as count 
            FROM MediaAsset 
            WHERE isLocal = 0 
              AND clipEmbedding = "none"
          `);
          const totalRemote = totalRemoteRow?.count || 0;
          let processedRemote = 0;

          let hasMoreRemoteIndex = true;
          while (hasMoreRemoteIndex) {
            // Fetch remote assets that don't have embeddings on server (marked as 'none')
            const remotePendingIndex = await db.getAllAsync(`
              SELECT id, hash 
              FROM MediaAsset 
              WHERE isLocal = 0 
                AND clipEmbedding = "none"
              LIMIT 10
            `);

            if (remotePendingIndex.length === 0) {
              hasMoreRemoteIndex = false;
              break;
            }

            console.log(`[AIService] Scheme B: Indexing ${remotePendingIndex.length} remote photos locally...`);
            for (const asset of remotePendingIndex) {
              processedRemote++;
              this.status = {
                isProcessing: true,
                current: 0,
                total: 0,
                message: `Extracting remote photo features (${Math.min(processedRemote, totalRemote)}/${totalRemote})...`
              };
              DeviceEventEmitter.emit('ai_processing_status', this.status);

              const tempUri = `${FileSystem.cacheDirectory}${asset.hash}.jpg`;
              try {
                // 1. Download preview image to local temporary file
                const previewUrl = `${url}/preview/${asset.hash}?width=320&height=-1&token=${token}`;
                
                console.log(`[AIService] Downloading preview for remote asset ${asset.hash}...`);
                const downloadRes = await FileSystem.downloadAsync(previewUrl, tempUri);
                if (downloadRes.status !== 200) {
                  throw new Error(`Failed to download preview, HTTP status ${downloadRes.status}`);
                }

                // 2. Extract embedding and phash from downloaded preview file
                const base64 = await this.getImageEmbedding(downloadRes.uri);
                let phash = null;
                try {
                  phash = await ExpoLomoHasher.generatePHashAsync(downloadRes.uri);
                } catch (pe) {
                  console.warn(`[AIService] Scheme B failed to calculate phash for remote asset ${asset.hash}:`, pe.message);
                }

                // 3. Save locally in SQLite
                await this.saveAssetEmbedding(asset.hash, base64, 1);
                if (phash && phash !== "0") {
                  await this.saveAssetPHash(asset.hash, phash);
                }
                console.log(`[AIService] Saved embedding and phash locally for remote asset ${asset.hash}`);

                // 4. Clean up temporary download file
                await FileSystem.deleteAsync(tempUri, { idempotent: true });

                // 5. Upload the newly calculated features to server so other devices can pull them!
                const serverAssetId = await this.getServerAssetIdByHash(asset.hash);
                if (serverAssetId) {
                  const device = Platform.OS === 'ios' ? 'ios' : 'android';
                  const payload = [];
                  payload.push({
                    Category: 'similarity',
                    SourceDevice: device,
                    AssetID: serverAssetId,
                    Name: 'shared.similarity.clip.embedding',
                    Value: base64,
                    Version: 1
                  });
                  if (phash && phash !== "0") {
                    payload.push({
                      Category: 'similarity',
                      SourceDevice: device,
                      AssetID: serverAssetId,
                      Name: 'shared.phash.fingerprint',
                      Value: phash,
                      Version: 1
                    });
                  }

                  await axios.post(`${url}/assets/metadata?force=1`, payload, {
                    headers: { Authorization: `token=${token}` },
                    timeout: 15000
                  });
                  console.log(`[AIService] Uploaded calculated features for remote asset ID ${serverAssetId} successfully.`);
                }
              } catch (err) {
                console.warn(`[AIService] Scheme B failed for remote asset ${asset.hash}:`, err.message);
                try { await FileSystem.deleteAsync(tempUri, { idempotent: true }); } catch (e) {}
                // Mark as 'failed' instead of 'none' to avoid infinite loops
                await this.saveAssetEmbedding(asset.hash, 'failed', -1);
              }
            }
          }
        }
      }

    } catch (error) {
      console.error('[AIService] Error in syncEmbeddings:', error);
    } finally {
      this.isSyncing = false;
      this.status = { isProcessing: false, current: 0, total: 0, message: 'Idle' };
      DeviceEventEmitter.emit('ai_processing_status', this.status);
      console.log('[AIService] Embeddings sync finished.');
    }
  }

  // Helper to get server integer AssetID from remote record filename in local DB
  async getServerAssetIdByHash(hash) {
    try {
      const db = AssetDBService.db;
      if (!db) return null;
      const row = await db.getFirstAsync(
        'SELECT filename FROM MediaAsset WHERE isLocal = 0 AND hash = ?',
        [hash]
      );
      if (row && row.filename) {
        const parts = row.filename.split('.');
        const idVal = parseInt(parts[0], 10);
        if (!isNaN(idVal)) {
          return idVal;
        }
      }
      return null;
    } catch (e) {
      console.warn('[AIService] Failed to get server asset ID for hash:', hash, e);
      return null;
    }
  }

  // 3. Similarity Search: perform fast Cosine Similarity in JavaScript
  async searchSimilarity(queryTextOrVector, threshold = null, limit = 50) {
    try {
      if (this.isCLIPClearedInMemory) {
        console.log('[AIService] CLIP cache cleared flag is active, returning empty results.');
        return [];
      }
      const isImageSearch = Array.isArray(queryTextOrVector) || queryTextOrVector instanceof Float32Array;
      
      let finalThreshold = threshold;
      if (finalThreshold === null) {
        if (isImageSearch) {
          finalThreshold = 0.55; // default fallback for image similarity search
        } else {
          finalThreshold = 0.25; // default fallback for text search
          try {
            const savedVal = await SecureStore.getItemAsync('lomorage_search_threshold');
            if (savedVal !== null) {
              const parsed = parseFloat(savedVal);
              if (!isNaN(parsed)) {
                finalThreshold = parsed;
              }
            }
          } catch (e) {
            console.warn('[AIService] Failed to read search threshold, using default 0.25:', e);
          }
        }
      }

      let textVector;
      let searchQuery = '';

      if (isImageSearch) {
        textVector = queryTextOrVector;
        searchQuery = '[Similar Photo]';
        console.log(`[AIService] Searching similarity by image vector input directly.`);
      } else {
        searchQuery = queryTextOrVector;
        // Detect if query contains Chinese characters and translate to English
        if (/[\u4e00-\u9fa5]/.test(queryTextOrVector)) {
          const cleanQuery = queryTextOrVector.trim().toLowerCase();
          const localMatch = LOCAL_TRANSLATION_DICT[cleanQuery];
          if (localMatch) {
            searchQuery = localMatch;
            console.log(`[AIService] Local dictionary translation: "${queryTextOrVector}" -> "${searchQuery}"`);
          } else {
            try {
              const res = await axios.get(
                `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(queryTextOrVector)}`,
                { timeout: 5000 }
              );
              if (res.data && res.data[0] && res.data[0][0] && res.data[0][0][0]) {
                searchQuery = res.data[0][0][0];
                console.log(`[AIService] Online translated search query: "${queryTextOrVector}" -> "${searchQuery}"`);
              }
            } catch (e) {
              console.warn('[AIService] Online translation failed, using original query:', e.message);
            }
          }
        }

        console.log(`[AIService] Searching for text: "${searchQuery}" (original: "${queryTextOrVector}")`);
        textVector = await this.getTextEmbedding(searchQuery);
      }

      const db = AssetDBService.db;
      if (!db) return [];

      // Fetch all embeddings metadata from local DB (exclude clipEmbedding string to keep database payload lightweight)
      const rows = await db.getAllAsync(`
        SELECT id, hash, filename, mediaType, createTime AS creationTime, isLocal, localCachePath, isFavorite 
        FROM MediaAsset 
        WHERE clipEmbedding IS NOT NULL 
          AND clipEmbedding != "" 
          AND clipEmbedding != "failed" 
          AND clipEmbedding != "none"
      `);

      // Identify which embeddings are missing from our in-memory cache
      const missingIds = [];
      for (const row of rows) {
        if (!this.vectorCache.has(row.id)) {
          missingIds.push(row.id);
        }
      }

      // Batch load missing embeddings from SQLite and parse them into memory
      if (missingIds.length > 0) {
        console.log(`[AIService] Vector cache miss for ${missingIds.length} items. Loading from DB...`);
        const chunkSize = 500;
        for (let i = 0; i < missingIds.length; i += chunkSize) {
          const chunk = missingIds.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          const chunkRows = await db.getAllAsync(`
            SELECT id, clipEmbedding FROM MediaAsset WHERE id IN (${placeholders})
          `, chunk);
          
          for (const crow of chunkRows) {
            if (crow.clipEmbedding && crow.clipEmbedding.length >= 100) {
              try {
                this.vectorCache.set(crow.id, base64ToFloat32Array(crow.clipEmbedding));
              } catch (e) {
                console.warn(`[AIService] Failed to parse embedding for asset ${crow.id}:`, e);
              }
            }
          }
        }
      }

      const allCandidates = [];
      let maxScore = 0;

      for (const row of rows) {
        const imageVector = this.vectorCache.get(row.id);
        if (!imageVector) continue;
        
        // Dot product (equivalent to Cosine Similarity since vectors are normalized)
        let score = 0;
        const dims = Math.min(textVector.length, imageVector.length);
        for (let i = 0; i < dims; i++) {
          score += textVector[i] * imageVector[i];
        }

        if (score >= 0.10) {
          if (score > maxScore) {
            maxScore = score;
          }
          allCandidates.push({
            id: row.id,
            hash: row.hash,
            filename: row.filename,
            mediaType: row.mediaType || 'photo',
            creationTime: row.creationTime || 0,
            isLocal: row.isLocal === 1,
            localCachePath: row.localCachePath,
            isFavorite: row.isFavorite === 1,
            score
          });
        }
      }

      let results;
      if (isImageSearch) {
        // For image-to-image search, use finalThreshold directly
        results = allCandidates.filter(c => c.score >= finalThreshold);
      } else {
        // For text search, calculate adaptive threshold but enforce a strict absolute minimum.
        // CLIP models generally output random noise correlations below 0.225.
        // If maxScore is low (no true matches exist), we MUST return empty rather than lowering the threshold to garbage levels.
        const ABSOLUTE_MIN_SCORE = 0.225;
        const floorThreshold = Math.max(ABSOLUTE_MIN_SCORE, finalThreshold - 0.05);
        const adaptiveThreshold = Math.max(floorThreshold, maxScore - 0.04);
        results = allCandidates.filter(c => c.score >= adaptiveThreshold);
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      // Deduplicate results by hash (prefer local over remote)
      const uniqueResults = [];
      const seenHashes = new Set();
      for (const r of results) {
        const h = r.hash || r.id.toString();
        if (!seenHashes.has(h)) {
          seenHashes.add(h);
          uniqueResults.push(r);
        }
      }

      console.log(`[AIService] Search maxScore=${maxScore.toFixed(4)}, matches=${uniqueResults.length} for "${searchQuery}".`);
      uniqueResults.slice(0, 5).forEach((r, idx) => {
        console.log(`  #${idx + 1}: filename=${r.filename}, score=${r.score.toFixed(4)}, isLocal=${r.isLocal}`);
      });

      return uniqueResults.slice(0, limit);
    } catch (error) {
      console.error('[AIService] Search similarity failed:', error);
      return [];
    }
  }

  // 4. Get or generate asset embedding on-the-fly (for image-to-image search)
  async getOrGenerateAssetEmbedding(assetId) {
    const db = AssetDBService.db;
    if (!db) return null;
    try {
      const row = await db.getFirstAsync(
        'SELECT clipEmbedding, isLocal, localCachePath, hash FROM MediaAsset WHERE id = ?',
        [assetId]
      );
      if (row && row.clipEmbedding && row.clipEmbedding.length > 100 && row.clipEmbedding !== 'failed' && row.clipEmbedding !== 'none') {
        return base64ToFloat32Array(row.clipEmbedding);
      }
      
      console.log(`[AIService] Embedding missing for asset ${assetId}, generating on the fly...`);
      let imageUri = null;
      if (row && row.isLocal === 1) {
        try {
          const info = await MediaService.getAssetInfo(assetId);
          imageUri = info?.localUri || info?.uri;
        } catch (e) {
          console.warn(`[AIService] Failed to get asset info for ${assetId} during on-the-fly embedding:`, e.message);
        }
        if (!imageUri) {
          if (Platform.OS === 'android') {
            imageUri = `content://media/external/images/media/${assetId}`;
          } else if (Platform.OS === 'ios') {
            imageUri = `ph://${assetId}`;
          }
        }
      } else if (row && row.localCachePath) {
        imageUri = row.localCachePath;
      } else if (row && row.hash) {
        // Download preview for remote asset
        try {
          const previewUrl = `${AuthService.getServerUrl()}/preview/${row.hash}?width=320&height=-1&token=${AuthService.getToken()}`;
          const tempUri = `${FileSystem.cacheDirectory}similar_temp_${row.hash}.jpg`;
          const downloadRes = await FileSystem.downloadAsync(previewUrl, tempUri);
          if (downloadRes.status === 200) {
            imageUri = tempUri;
          }
        } catch (e) {
          console.warn('[AIService] Failed to download remote preview for on-the-fly embedding:', e);
        }
      }
      
      if (imageUri) {
        const base64 = await this.getImageEmbedding(imageUri);
        if (base64 && base64.length > 100) {
          await this.saveAssetEmbedding(assetId, base64);
          // Delete temp file if remote
          if (imageUri.includes('similar_temp_')) {
            try { await FileSystem.deleteAsync(imageUri, { idempotent: true }); } catch (e) {}
          }
          return base64ToFloat32Array(base64);
        }
      }
    } catch (err) {
      console.error('[AIService] Failed to get/generate embedding:', err);
    }
    return null;
  }



  // Find duplicate groups using pHash Hamming distance <= 10.
  // Returns an array of groups, each containing detailed asset objects sorted by quality (highest first).
  async findDuplicateGroups(forceRescan = false) {
    try {
      if (forceRescan) {
        this.clearDuplicateCache();
      }
      const now = Date.now();
      if (this.duplicateGroupsCache && (now - this.duplicateGroupsCacheTime < 300000)) {
        console.log('[AIService] Returning cached duplicate groups');
        return this.duplicateGroupsCache;
      }

      console.time('[AIService] duplicate_scan_total');
      if (this.isPHashClearedInMemory) {
        console.log('[AIService] pHash cache cleared flag is active, returning empty duplicate groups.');
        return [];
      }
      // 1. Get all assets with phash from SQLite
      const assets = await AssetDBService.getAssetsWithPHash();
      console.log(`[AIService] DB fetch completed. Total assets with pHash: ${assets.length}`);
      if (assets.length === 0) return [];

      // 1.5 Deduplicate local/remote synced pairs by Hash
      const uniqueByHash = new Map();
      for (const a of assets) {
        if (a.hash && uniqueByHash.has(a.hash)) {
          // Prefer local asset if both exist
          if (a.isLocal === 1) {
            uniqueByHash.set(a.hash, a);
          }
        } else if (a.hash) {
          uniqueByHash.set(a.hash, a);
        } else {
          // No hash, just use ID
          uniqueByHash.set(a.id, a);
        }
      }
      const deduplicatedAssets = Array.from(uniqueByHash.values());
      console.log(`[AIService] Hash deduplication completed. Unique assets by hash: ${deduplicatedAssets.length}`);

      // 2. Parse phash into BigInts and Pre-group identical exact matches
      const exactGroupsMap = new Map();
      for (const a of deduplicatedAssets) {
        try {
          if (a.phash) {
            const phashBig = BigInt(a.phash);
            const pLow = Number(phashBig & 0xffffffffn) | 0;
            const pHigh = Number((phashBig >> 32n) & 0xffffffffn) | 0;
            if (!exactGroupsMap.has(a.phash)) {
              exactGroupsMap.set(a.phash, { pLow, pHigh, items: [] });
            }
            exactGroupsMap.get(a.phash).items.push({ ...a });
          }
        } catch (e) {
          console.warn(`[AIService] Invalid phash BigInt for asset ${a.id}:`, a.phash);
        }
      }

      const uniquePhashGroups = Array.from(exactGroupsMap.values());
      console.log(`[AIService] Exact phash grouping completed. Unique phash groups: ${uniquePhashGroups.length}`);
      if (uniquePhashGroups.length === 0) return [];

      // 3. Fast popcount helper (computes hamming distance of 64-bit BigInts in ~50ns)
      // 3. Fast popcount helper for 32-bit ints
      const countBits = (v) => {
        v = v - ((v >>> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
      };

      // 4. Greedy clustering loop (Hamming distance <= 6)
      const clusters = [];
      const visited = new Set();
      console.time('[AIService] greedy_clustering');

      const len = uniquePhashGroups.length;
      const pLowArr = new Int32Array(len);
      const pHighArr = new Int32Array(len);
      for(let i=0; i<len; i++) {
        pLowArr[i] = uniquePhashGroups[i].pLow;
        pHighArr[i] = uniquePhashGroups[i].pHigh;
      }

      for (let i = 0; i < len; i++) {
        // Yield to event loop to prevent UI freezing
        if (i > 0 && i % 500 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        const groupA = uniquePhashGroups[i];
        const representativeId = groupA.items[0].id;
        
        if (visited.has(representativeId)) continue;

        let cluster = [...groupA.items];
        const pLowA = pLowArr[i];
        const pHighA = pHighArr[i];
        
        for (let j = i + 1; j < len; j++) {
          let vLow = pLowA ^ pLowArr[j];
          vLow = vLow - ((vLow >>> 1) & 0x55555555);
          vLow = (vLow & 0x33333333) + ((vLow >>> 2) & 0x33333333);
          const cLow = (((vLow + (vLow >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
          
          if (cLow > 6) continue;

          let vHigh = pHighA ^ pHighArr[j];
          vHigh = vHigh - ((vHigh >>> 1) & 0x55555555);
          vHigh = (vHigh & 0x33333333) + ((vHigh >>> 2) & 0x33333333);
          const cHigh = (((vHigh + (vHigh >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;

          if (cLow + cHigh <= 6) {
            const groupB = uniquePhashGroups[j];
            const repBId = groupB.items[0].id;
            if (visited.has(repBId)) continue;

            cluster = cluster.concat(groupB.items);
            visited.add(repBId);
          }
        }

        if (cluster.length > 1) {
          visited.add(representativeId);
          clusters.push(cluster);
        }
      }
      console.timeEnd('[AIService] greedy_clustering');
      console.log(`[AIService] Greedy clustering completed. Clusters found: ${clusters.length}`);

      // 5. Build result clusters - use data already in SQLite, skip expensive network/filesystem calls.
      // Sort heuristic: prefer local assets (isLocal=1) over remote, then newer createTime first.
      // This avoids hundreds of MediaService.getAssetInfo / axios.head calls that were causing the long wait.
      const url = AuthService.getServerUrl();
      const token = AuthService.getToken();
      const enrichedClusters = clusters.map(cluster => {
        const sorted = [...cluster].sort((a, b) => {
          // Local beats remote
          const localDiff = (b.isLocal === 1 ? 1 : 0) - (a.isLocal === 1 ? 1 : 0);
          if (localDiff !== 0) return localDiff;
          // Newer createTime first
          return (b.createTime || 0) - (a.createTime || 0);
        });

        const filteredCluster = [];
        const seenIds = new Set();
        for (const asset of sorted) {
          if (!seenIds.has(asset.id)) {
            seenIds.add(asset.id);
            filteredCluster.push(asset);
          }
        }

        return filteredCluster.map(asset => {
          let displayUri = null;
          if (asset.isLocal === 1) {
            // Will be resolved lazily by the UI when the user views the asset
            displayUri = null;
          } else if (asset.localCachePath) {
            displayUri = asset.localCachePath;
          } else {
            displayUri = `${url}/preview/${asset.hash}?width=320&height=-1&token=${token}`;
          }
          return {
            id: asset.id,
            hash: asset.hash,
            isLocal: asset.isLocal === 1,
            filename: asset.filename,
            createTime: asset.createTime,
            mediaType: asset.mediaType,
            width: 0,
            height: 0,
            size: 0,
            displayUri,
            qualityScore: 0
          };
        });
      });

      // Filter out clusters that have less than 2 items after deduplication
      const finalClusters = enrichedClusters.filter(c => c.length > 1);

      this.duplicateGroupsCache = finalClusters;
      this.duplicateGroupsCacheTime = Date.now();
      console.timeEnd('[AIService] duplicate_scan_total');
      return finalClusters;
    } catch (error) {
      console.timeEnd('[AIService] duplicate_scan_total');
      console.error('[AIService] Failed in findDuplicateGroups:', error);
      return [];
    }
  }

  // Reset and force recalculate all photo pHashes for duplicate cleaning
  async forceRebuildPHash() {
    const db = AssetDBService.db;
    if (!db) return;
    try {
      console.log('[AIService] Resetting all pHash cache and ignored duplicate records in DB...');
      this.isPHashClearedInMemory = true;
      
      // Run the DB updates in the background without awaiting them, so the UI is released instantly
      // We also optimize the query with "WHERE phash IS NOT NULL" to skip updating already NULL rows
      Promise.all([
        db.runAsync('UPDATE MediaAsset SET phash = NULL WHERE phash IS NOT NULL'),
        db.runAsync('DELETE FROM IgnoredDuplicate')
      ]).then(() => {
        console.log('[AIService] All pHash cache and ignored duplicate records reset successfully.');
        this.isPHashClearedInMemory = false;
        // Trigger extraction and sync immediately in the background asynchronously
        this.processLocalEmbeddings(50, true).then(() => {
          this.syncEmbeddings(true).catch(e => console.warn('[AIService] Background syncEmbeddings for pHash failed:', e.message));
        }).catch(e => {
          console.error('[AIService] Background processLocalEmbeddings for pHash failed:', e);
        });
      }).catch(e => {
        this.isPHashClearedInMemory = false;
        console.error('[AIService] Failed to reset duplicate records in DB:', e);
      });
    } catch (e) {
      this.isPHashClearedInMemory = false;
      console.error('[AIService] Failed to rebuild pHash cache:', e);
      throw e;
    }
  }

  // Reset and force recalculate all CLIP vectors for semantic search
  async forceRebuildCLIP() {
    const db = AssetDBService.db;
    if (!db) return;
    try {
      console.log('[AIService] Resetting all CLIP embeddings cache in DB...');
      this.isCLIPClearedInMemory = true;
      
      // Run the DB update in the background without awaiting it, so the UI is released instantly
      // We also optimize the query with "WHERE ... IS NOT NULL" to skip updating already NULL rows
      db.runAsync('UPDATE MediaAsset SET clipEmbedding = NULL, clipEmbeddingVersion = NULL WHERE clipEmbedding IS NOT NULL OR clipEmbeddingVersion IS NOT NULL').then(() => {
        console.log('[AIService] All CLIP embeddings cache reset in DB successfully.');
        this.isCLIPClearedInMemory = false;
        // Trigger extraction and sync immediately in the background asynchronously
        this.processLocalEmbeddings(50, true).then(() => {
          this.syncEmbeddings(true).catch(e => console.warn('[AIService] Background syncEmbeddings for CLIP failed:', e.message));
        }).catch(e => {
          console.error('[AIService] Background processLocalEmbeddings for CLIP failed:', e);
        });
      }).catch(e => {
        this.isCLIPClearedInMemory = false;
        console.error('[AIService] Failed to update clipEmbedding to NULL in DB:', e);
      });
    } catch (e) {
      this.isCLIPClearedInMemory = false;
      console.error('[AIService] Failed to rebuild CLIP cache:', e);
      throw e;
    }
  }
}

export default new AIService();

// Define task globally so it fires in background mode
TaskManager.defineTask(BACKGROUND_AI_SYNC_TASK, async () => {
    console.log('[Background AI Sync Task] Starting background AI fetch...');
    
    // Do not run if already processing in foreground
    const AIServiceInstance = require('./AIService').default;
    if (AIServiceInstance.isSyncing) {
        console.log('[Background AI Sync Task] AIService is currently syncing in foreground, skipping.');
        return BackgroundTask.BackgroundTaskResult.Success;
    }

    try {
        // Enforce idle check (WiFi + Charging) to protect user battery and data
        const isIdle = await AIServiceInstance.isIdleForAI();
        if (!isIdle) {
            console.log('[Background AI Sync Task] Device not on WiFi + Charging. Skipping background AI fetch.');
            return BackgroundTask.BackgroundTaskResult.Success;
        }

        const savedRemoteAI = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
        if (savedRemoteAI === 'false') {
            console.log('[Background AI Sync Task] Remote AI processing disabled. Skipping background AI fetch.');
            return BackgroundTask.BackgroundTaskResult.Success;
        }

        await AIServiceInstance.syncEmbeddings(true);
        console.log('[Background AI Sync Task] Background AI fetch completed successfully.');
        return BackgroundTask.BackgroundTaskResult.NewData;
    } catch (error) {
        console.error('[Background AI Sync Task] Failed:', error);
        return BackgroundTask.BackgroundTaskResult.Failed;
    }
});
