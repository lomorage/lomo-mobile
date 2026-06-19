import { Platform, AppState, DeviceEventEmitter } from 'react-native';
import axios from 'axios';
import * as ExpoLomoHasher from '../../modules/expo-lomo-hasher';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import AssetDBService from './AssetDBService';
import AuthService from './AuthService';
import MediaService from './MediaService';

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
  async syncEmbeddings() {
    if (this.isSyncing) return;
    const savedAiEnabled = await SecureStore.getItemAsync('lomorage_ai_enabled');
    const aiEnabled = savedAiEnabled !== 'false';
    if (!aiEnabled) {
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
            const serverAssetId = await this.getServerAssetIdByHash(asset.hash);
            if (!serverAssetId) {
              console.log(`[AIService] Skipping upload for ${asset.hash}: server ID not synced yet.`);
              continue;
            }

            const device = Platform.OS === 'ios' ? 'ios' : 'android';
            const name = `${device}.similarity.clip.embedding`;
            
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

      // Part B: Download remote embeddings and phash from server
      const savedRemoteAI = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
      const remoteAIEnabled = savedRemoteAI === 'true';
      if (!remoteAIEnabled) {
        console.log('[AIService] Skip remote embedding download: remote AI indexing disabled.');
      } else {
      let hasMoreDownloads = true;
      while (hasMoreDownloads) {
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
        for (const asset of remotePendingDownload) {
          try {
            const res = await axios.get(`${url}/asset/metadata/${asset.hash}`, {
              headers: { Authorization: `token=${token}` },
              timeout: 10000,
              skipAutoProbe: true
            });
            const data = res.data;
            let foundEmbedding = false;
            let foundPHash = false;
            
            if (data && data.Metadatas) {
              for (const meta of data.Metadatas) {
                if (meta.Name === 'ios.phash.fingerprint') {
                  if (meta.Value && meta.Value.length > 0) {
                    await this.saveAssetPHash(asset.hash, meta.Value);
                    foundPHash = true;
                    console.log(`[AIService] Synced phash ${meta.Value} from server for remote asset ${asset.hash}`);
                  }
                }
                if (meta.Name && meta.Name.endsWith('.similarity.clip.embedding')) {
                  if (meta.Value && meta.Value.length > 100) {
                    await this.saveAssetEmbedding(asset.hash, meta.Value, 1);
                    foundEmbedding = true;
                    console.log(`[AIService] Synced embedding from server for remote asset ${asset.hash}`);
                  }
                }
              }
            }

            if (!foundEmbedding) {
              await this.saveAssetEmbedding(asset.hash, 'none', 1);
            }
            if (!foundPHash) {
              await this.saveAssetPHash(asset.hash, 'none');
            }
          } catch (e) {
            if (e.response && e.response.status === 404) {
              await this.saveAssetEmbedding(asset.hash, 'none', 1);
              await this.saveAssetPHash(asset.hash, 'none');
            } else {
              console.warn(`[AIService] Failed to get metadata for remote asset ${asset.hash}:`, e.message);
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Part C: Scheme B - Local extraction for remote photos (idle Wi-Fi/Charging only)
      const savedRemoteAI = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
      const isRemoteAIEnabled = savedRemoteAI === 'true';
      
      if (isRemoteAIEnabled) {
        const isIdle = await this.isIdleForAI();
        if (!isIdle) {
          console.log('[AIService] Scheme B: Skip remote photos local indexing (device is not charging or not on Wi-Fi).');
        } else {
          // Fetch remote assets that don't have embeddings on server (marked as 'none')
          const remotePendingIndex = await db.getAllAsync(`
            SELECT id, hash 
            FROM MediaAsset 
            WHERE isLocal = 0 
              AND clipEmbedding = "none"
            LIMIT 10
          `);

          if (remotePendingIndex.length > 0) {
            console.log(`[AIService] Scheme B: Indexing ${remotePendingIndex.length} remote photos locally...`);
            for (const asset of remotePendingIndex) {
              const tempUri = `${FileSystem.cacheDirectory}${asset.hash}.jpg`;
              try {
                // 1. Download preview image to local temporary file
                const previewUrl = `${url}/preview/${asset.hash}?width=320&height=-1&token=${token}`;
                
                console.log(`[AIService] Downloading preview for remote asset ${asset.hash}...`);
                const downloadRes = await FileSystem.downloadAsync(previewUrl, tempUri);
                if (downloadRes.status !== 200) {
                  throw new Error(`Failed to download preview, HTTP status ${downloadRes.status}`);
                }

                // 2. Extract embedding from downloaded preview file
                const base64 = await this.getImageEmbedding(downloadRes.uri);

                // 3. Save locally in SQLite
                await this.saveAssetEmbedding(asset.hash, base64, 1);
                console.log(`[AIService] Saved embedding locally for remote asset ${asset.hash}`);

                // 4. Clean up temporary download file
                await FileSystem.deleteAsync(tempUri, { idempotent: true });

                // 5. Upload the newly calculated embedding to server so other devices can pull it!
                const serverAssetId = await this.getServerAssetIdByHash(asset.hash);
                if (serverAssetId) {
                  const device = Platform.OS === 'ios' ? 'ios' : 'android';
                  const name = `${device}.similarity.clip.embedding`;
                  const payload = [{
                    Category: 'similarity',
                    SourceDevice: device,
                    AssetID: serverAssetId,
                    Name: name,
                    Value: base64,
                    Version: 1
                  }];

                  await axios.post(`${url}/assets/metadata?force=1`, payload, {
                    headers: { Authorization: `token=${token}` },
                    timeout: 15000
                  });
                  console.log(`[AIService] Uploaded calculated embedding for remote asset ID ${serverAssetId} successfully.`);
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
      } // end else remoteAIEnabled

    } catch (error) {
      console.error('[AIService] Error in syncEmbeddings:', error);
    } finally {
      this.isSyncing = false;
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
        // For image-to-image search, use finalThreshold directly (no adaptive relative subtraction because maxScore of self-match is 1.0)
        results = allCandidates.filter(c => c.score >= finalThreshold);
      } else {
        // For text search, calculate adaptive threshold based on maximum similarity score
        const floorThreshold = Math.max(0.12, finalThreshold - 0.06);
        const adaptiveThreshold = Math.max(floorThreshold, maxScore - 0.04);
        results = allCandidates.filter(c => c.score >= adaptiveThreshold);
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      console.log(`[AIService] Search maxScore=${maxScore.toFixed(4)}, matches=${results.length} for "${searchQuery}".`);
      results.slice(0, 5).forEach((r, idx) => {
        console.log(`  #${idx + 1}: filename=${r.filename}, score=${r.score.toFixed(4)}, isLocal=${r.isLocal}`);
      });

      return results.slice(0, limit);
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

  // Get or generate asset pHash on-the-fly (for pHash similar search)
  async getOrGenerateAssetPHash(assetId) {
    const db = AssetDBService.db;
    if (!db) return null;
    try {
      const row = await db.getFirstAsync(
        'SELECT phash, isLocal, localCachePath, hash FROM MediaAsset WHERE id = ?',
        [assetId]
      );
      if (row && row.phash && row.phash.length > 5 && row.phash !== 'failed' && row.phash !== 'none') {
        return row.phash;
      }
      
      console.log(`[AIService] pHash missing for asset ${assetId}, generating on the fly...`);
      let imageUri = null;
      if (row && row.isLocal === 1) {
        try {
          const info = await MediaService.getAssetInfo(assetId);
          imageUri = info?.localUri || info?.uri;
        } catch (e) {
          console.warn(`[AIService] Failed to get asset info for ${assetId} during on-the-fly phash:`, e.message);
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
          const tempUri = `${FileSystem.cacheDirectory}phash_temp_${row.hash}.jpg`;
          const downloadRes = await FileSystem.downloadAsync(previewUrl, tempUri);
          if (downloadRes.status === 200) {
            imageUri = tempUri;
          }
        } catch (e) {
          console.warn('[AIService] Failed to download remote preview for on-the-fly phash:', e);
        }
      }
      
      if (imageUri) {
        const phash = await ExpoLomoHasher.generatePHashAsync(imageUri);
        if (phash && phash.length > 5) {
          await this.saveAssetPHash(assetId, phash);
          // Delete temp file if remote
          if (imageUri.includes('phash_temp_')) {
            try { await FileSystem.deleteAsync(imageUri, { idempotent: true }); } catch (e) {}
          }
          return phash;
        }
      }
    } catch (err) {
      console.error('[AIService] Failed to get/generate phash:', err);
    }
    return null;
  }

  // Perceptual Hash similarity search using Hamming distance
  async searchSimilarityByPHash(queryPHash, threshold = 10, limit = 50) {
    try {
      const db = AssetDBService.db;
      if (!db) return [];

      // Fetch all assets with phash
      const rows = await db.getAllAsync(`
        SELECT id, hash, filename, mediaType, createTime AS creationTime, isLocal, localCachePath, isFavorite, phash 
        FROM MediaAsset 
        WHERE phash IS NOT NULL 
          AND phash != "" 
          AND phash != "failed" 
          AND phash != "none"
      `);

      const results = [];
      const queryVal = BigInt(queryPHash);

      for (const row of rows) {
        try {
          const candidateVal = BigInt(row.phash);
          // Hamming distance (popcount of XOR)
          let xor = BigInt.asUintN(64, queryVal ^ candidateVal);
          let dist = 0;
          while (xor > 0n) {
            if (xor & 1n) {
              dist++;
            }
            xor >>= 1n;
          }

          if (dist <= threshold) {
            // Map Hamming distance to a score between 0.0 and 1.0 (distance 0 is 100% match)
            const score = 1.0 - (dist / 64.0);
            results.push({
              id: row.id,
              hash: row.hash,
              filename: row.filename,
              mediaType: row.mediaType || 'photo',
              creationTime: row.creationTime || 0,
              isLocal: row.isLocal === 1,
              localCachePath: row.localCachePath,
              isFavorite: row.isFavorite === 1,
              score,
              isPHash: true
            });
          }
        } catch (pe) {
          console.warn(`[AIService] Failed to calculate Hamming distance for ${row.filename}:`, pe);
        }
      }

      // Sort by score descending (smaller Hamming distance first)
      results.sort((a, b) => b.score - a.score);
      console.log(`[AIService] pHash search found ${results.length} matching similar photos (threshold <= ${threshold}).`);
      results.slice(0, 5).forEach((r, idx) => {
        console.log(`  #${idx + 1}: filename=${r.filename}, score=${r.score.toFixed(4)} (distance=${Math.round((1.0 - r.score) * 64)})`);
      });

      return results.slice(0, limit);
    } catch (error) {
      console.error('[AIService] Search similarity by phash failed:', error);
      return [];
    }
  }

  // Find duplicate groups using pHash Hamming distance <= 10.
  // Returns an array of groups, each containing detailed asset objects sorted by quality (highest first).
  async findDuplicateGroups() {
    try {
      if (this.isPHashClearedInMemory) {
        console.log('[AIService] pHash cache cleared flag is active, returning empty duplicate groups.');
        return [];
      }
      // 1. Get all assets with phash from SQLite
      const assets = await AssetDBService.getAssetsWithPHash();
      if (assets.length === 0) return [];

      // 2. Parse phash into BigInts for fast bitwise XOR
      const parsedAssets = [];
      for (const a of assets) {
        try {
          if (a.phash) {
            parsedAssets.push({
              ...a,
              phashBig: BigInt(a.phash)
            });
          }
        } catch (e) {
          console.warn(`[AIService] Invalid phash BigInt for asset ${a.id}:`, a.phash);
        }
      }

      // 3. Fast popcount helper (computes hamming distance of 64-bit BigInts in ~50ns)
      const popcountBigInt64 = (x) => {
        const low = Number(x & 0xffffffffn);
        const high = Number((x >> 32n) & 0xffffffffn);
        const countBits = (v) => {
          v = v - ((v >> 1) & 0x55555555);
          v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
          return (((v + (v >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
        };
        return countBits(low) + countBits(high);
      };

      // 4. Greedy clustering loop (Hamming distance <= 6)
      const clusters = [];
      const visited = new Set();

      for (let i = 0; i < parsedAssets.length; i++) {
        const assetA = parsedAssets[i];
        if (visited.has(assetA.id)) continue;

        const cluster = [assetA];
        for (let j = i + 1; j < parsedAssets.length; j++) {
          const assetB = parsedAssets[j];
          if (visited.has(assetB.id)) continue;

          const dist = popcountBigInt64(assetA.phashBig ^ assetB.phashBig);
          if (dist <= 6) {
            console.log(`[AIService] Match: ${assetA.filename} (${assetA.phash}) <-> ${assetB.filename} (${assetB.phash}), distance = ${dist}`);
            cluster.push(assetB);
            visited.add(assetB.id);
          }
        }

        if (cluster.length > 1) {
          visited.add(assetA.id);
          clusters.push(cluster);
        }
      }

      // 5. Enrich cluster assets with metadata (size, width, height) to sort by quality
      const url = AuthService.getServerUrl();
      const token = AuthService.getToken();
      const db = AssetDBService.db;

      // Collect all raw assets to enrich them in parallel
      const assetsToEnrich = [];
      for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
        const rawCluster = clusters[clusterIndex];
        for (let assetIndex = 0; assetIndex < rawCluster.length; assetIndex++) {
          assetsToEnrich.push({
            asset: rawCluster[assetIndex],
            clusterIndex
          });
        }
      }

      const enrichmentPromises = assetsToEnrich.map(async (item) => {
        const asset = item.asset;
        let width = 0;
        let height = 0;
        let size = 0;
        let displayUri = null;

        if (asset.isLocal) {
          try {
            const localInfo = await MediaService.getAssetInfo(asset.id);
            if (localInfo) {
              width = localInfo.width || 0;
              height = localInfo.height || 0;
              displayUri = localInfo.localUri || localInfo.uri;
              if (Platform.OS === 'android' && displayUri && displayUri.startsWith('content://') && (localInfo.mediaType === 'video' || displayUri.includes('/video/'))) {
                displayUri = `${displayUri}/thumbnail`;
              }
              
              if (displayUri) {
                const fileInfo = await FileSystem.getInfoAsync(displayUri, { size: true });
                size = fileInfo?.size || 0;
              }
            }
          } catch (e) {
            console.warn(`[AIService] Failed to get local asset info for duplicate check:`, e.message);
          }
        } else {
          if (asset.localCachePath) {
            displayUri = asset.localCachePath;
          } else {
            displayUri = `${url}/preview/${asset.hash}?width=320&height=-1&token=${token}`;
          }

          // 1. Try checking the DB-cached metadata field first (which we SELECT in getAssetsWithPHash)
          let dbCached = false;
          if (asset.metadata) {
            try {
              const metaObj = JSON.parse(asset.metadata);
              width = metaObj?.width || 0;
              height = metaObj?.height || 0;
              size = metaObj?.size || 0;
              if (size > 0) {
                dbCached = true;
              }
            } catch (e) {
              console.warn('[AIService] Failed to parse cached metadata:', e.message);
            }
          }

          // 2. If size not cached in SQLite metadata column, fetch it via fast axios HEAD and write back
          if (!dbCached) {
            try {
              const headRes = await axios.head(`${url}/asset/${asset.hash}`, {
                headers: { Authorization: `token=${token}` },
                timeout: 5000,
                skipAutoProbe: true
              });
              if (headRes && headRes.headers) {
                const contentLength = headRes.headers['content-length'] || headRes.headers['Content-Length'];
                if (contentLength) {
                  size = parseInt(contentLength, 10) || 0;
                }
              }

              // Update the DB cache with the size so subsequent duplicate checks are instant
              if (size > 0 && db) {
                const metadataStr = JSON.stringify({ size, width: 0, height: 0 });
                await db.runAsync('UPDATE MediaAsset SET metadata = ? WHERE hash = ?', [metadataStr, asset.hash]);
                console.log(`[AIService] Cached remote asset metadata for ${asset.hash}: size=${size}`);
              }
            } catch (he) {
              console.warn(`[AIService] Failed to get remote file size for duplicate check:`, he.message);
            }
          }
        }

        return {
          clusterIndex: item.clusterIndex,
          enrichedAsset: {
            id: asset.id,
            hash: asset.hash,
            isLocal: asset.isLocal === 1,
            filename: asset.filename,
            createTime: asset.createTime,
            mediaType: asset.mediaType,
            width,
            height,
            size,
            displayUri: displayUri || asset.localCachePath,
            qualityScore: width * height + size / 1000
          }
        };
      });

      const enrichedResults = await Promise.all(enrichmentPromises);

      // Reconstruct clusters
      const enrichedClusters = Array.from({ length: clusters.length }, () => []);
      for (const res of enrichedResults) {
        enrichedClusters[res.clusterIndex].push(res.enrichedAsset);
      }

      // Sort each cluster descending by qualityScore
      for (const cluster of enrichedClusters) {
        cluster.sort((a, b) => b.qualityScore - a.qualityScore);
      }

      return enrichedClusters;
    } catch (error) {
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
          this.syncEmbeddings().catch(e => console.warn('[AIService] Background syncEmbeddings for pHash failed:', e.message));
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
          this.syncEmbeddings().catch(e => console.warn('[AIService] Background syncEmbeddings for CLIP failed:', e.message));
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
