import { Platform } from 'react-native';
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

class AIService {
  constructor() {
    this.isProcessing = false;
    this.isSyncing = false;
  }

  // Check if device is connected to Wi-Fi and charging
  async isIdleForAI() {
    try {
      const netState = await Network.getNetworkStateAsync();
      const isWifi = netState.type === Network.NetworkStateType.WIFI;

      const battState = await Battery.getBatteryStateAsync();
      const isCharging = battState === Battery.BatteryState.CHARGING || battState === Battery.BatteryState.FULL;

      return isWifi && isCharging;
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
  // 1. Local extraction loop: processes local assets that don't have embeddings yet in non-blocking batches
  async processLocalEmbeddings(limit = 10) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    console.log('[AIService] Starting local embeddings processing...');

    try {
      const db = AssetDBService.db;
      if (!db) return;

      let hasMore = true;
      while (hasMore) {
        const pending = await db.getAllAsync(
          'SELECT id, hash FROM MediaAsset WHERE isLocal = 1 AND mediaType = "photo" AND (clipEmbeddingVersion IS NULL OR clipEmbeddingVersion < 1) LIMIT ?',
          [limit]
        );

        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`[AIService] Processing batch of ${pending.length} local photos for embedding...`);

        for (const asset of pending) {
          try {
            console.log(`[AIService] Processing embedding for local asset ${asset.id}...`);
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

            const base64 = await this.getImageEmbedding(localPath);
            await this.saveAssetEmbedding(asset.id, base64, 1);
            console.log(`[AIService] Saved embedding locally for asset ${asset.id}.`);
          } catch (err) {
            console.warn(`[AIService] Failed to process asset ${asset.id}:`, err.message);
            await this.saveAssetEmbedding(asset.id, 'failed', -1);
          }
        }
        // Yield to the JS thread to keep the UI smooth
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (error) {
      console.error('[AIService] Error in processLocalEmbeddings:', error);
    } finally {
      this.isProcessing = false;
      console.log('[AIService] Local embeddings processing finished.');
    }
  }

  // Helper to update embedding in SQLite
  async saveAssetEmbedding(idOrHash, embeddingBase64, version = 1) {
    const db = AssetDBService.db;
    if (!db) return;
    await db.runAsync(
      'UPDATE MediaAsset SET clipEmbedding = ?, clipEmbeddingVersion = ? WHERE id = ? OR hash = ?',
      [embeddingBase64, version, idOrHash, idOrHash]
    );
  }

  // 2. Synchronize embeddings with lomo-backend
  async syncEmbeddings() {
    if (this.isSyncing) return;
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
          } catch (e) {
            console.warn(`[AIService] Failed to upload embedding for ${asset.hash}:`, e.message);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Part B: Download remote embeddings from server
      let hasMoreDownloads = true;
      while (hasMoreDownloads) {
        const remotePendingDownload = await db.getAllAsync(`
          SELECT id, hash 
          FROM MediaAsset 
          WHERE isLocal = 0 
            AND (clipEmbedding IS NULL OR clipEmbedding = "") 
          LIMIT 20
        `);

        if (remotePendingDownload.length === 0) {
          hasMoreDownloads = false;
          break;
        }

        console.log(`[AIService] Syncing batch of ${remotePendingDownload.length} remote embeddings from server...`);
        for (const asset of remotePendingDownload) {
          try {
            const res = await axios.get(`${url}/asset/metadata/${asset.hash}`, {
              headers: { Authorization: `token=${token}` },
              timeout: 10000,
              skipAutoProbe: true
            });
            const data = res.data;
            let foundEmbedding = false;
            
            if (data && data.Metadatas) {
              for (const meta of data.Metadatas) {
                if (meta.Name && meta.Name.endsWith('.similarity.clip.embedding')) {
                  if (meta.Value && meta.Value.length > 100) {
                    await this.saveAssetEmbedding(asset.hash, meta.Value, 1);
                    foundEmbedding = true;
                    console.log(`[AIService] Synced embedding from server for remote asset ${asset.hash}`);
                    break;
                  }
                }
              }
            }

            if (!foundEmbedding) {
              await this.saveAssetEmbedding(asset.hash, 'none', 1);
            }
          } catch (e) {
            if (e.response && e.response.status === 404) {
              await this.saveAssetEmbedding(asset.hash, 'none', 1);
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
  async searchSimilarity(queryText, threshold = null, limit = 50) {
    try {
      let finalThreshold = threshold;
      if (finalThreshold === null) {
        finalThreshold = 0.25; // default fallback
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

      let searchQuery = queryText;
      // Detect if query contains Chinese characters and translate to English
      if (/[\u4e00-\u9fa5]/.test(queryText)) {
        try {
          const res = await axios.get(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(queryText)}`,
            { timeout: 5000 }
          );
          if (res.data && res.data[0] && res.data[0][0] && res.data[0][0][0]) {
            searchQuery = res.data[0][0][0];
            console.log(`[AIService] Translated search query: "${queryText}" -> "${searchQuery}"`);
          }
        } catch (e) {
          console.warn('[AIService] Translation failed, using original query:', e.message);
        }
      }

      console.log(`[AIService] Searching for: "${searchQuery}" (original: "${queryText}")`);
      const db = AssetDBService.db;
      if (!db) return [];

      // Get text vector using translation if available
      const textVector = await this.getTextEmbedding(searchQuery);

      // Fetch all embeddings from local DB in one single query
      const rows = await db.getAllAsync(`
        SELECT id, hash, filename, mediaType, createTime AS creationTime, isLocal, localCachePath, isFavorite, clipEmbedding 
        FROM MediaAsset 
        WHERE clipEmbedding IS NOT NULL 
          AND clipEmbedding != "" 
          AND clipEmbedding != "failed" 
          AND clipEmbedding != "none"
      `);

      const allCandidates = [];
      let maxScore = 0;

      for (const row of rows) {
        if (!row.clipEmbedding || row.clipEmbedding.length < 100) {
          continue;
        }

        const imageVector = base64ToFloat32Array(row.clipEmbedding);
        
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

      // Calculate adaptive threshold:
      // - The absolute floor is determined by (finalThreshold - 0.06), e.g., if user set 0.25, floor is 0.19.
      // - The relative threshold is (maxScore - 0.04), allowing candidates close to the top match to appear.
      const floorThreshold = Math.max(0.12, finalThreshold - 0.06);
      const adaptiveThreshold = Math.max(floorThreshold, maxScore - 0.04);

      const results = allCandidates.filter(c => c.score >= adaptiveThreshold);

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      console.log(`[AIService] Search maxScore=${maxScore.toFixed(4)}, adaptiveThreshold=${adaptiveThreshold.toFixed(4)} (floor=${floorThreshold.toFixed(4)}) for "${searchQuery}". Found ${results.length} matches.`);
      results.slice(0, 5).forEach((r, idx) => {
        console.log(`  #${idx + 1}: filename=${r.filename}, score=${r.score.toFixed(4)}, isLocal=${r.isLocal}`);
      });

      return results.slice(0, limit);
    } catch (error) {
      console.error('[AIService] Search similarity failed:', error);
      return [];
    }
  }
}

export default new AIService();
