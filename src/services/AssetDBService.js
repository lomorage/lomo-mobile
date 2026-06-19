import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import MetricsTracker from '../utils/MetricsTracker';

class AssetDBService {
  constructor() {
    this.dbName = 'lomoAssets.db';
    this.db = null;
    this.writePromise = Promise.resolve(); // Promise chain to serialize all database writes
  }

  // Promise-based mutex lock for serializing writes sequentially
  async executeWrite(callback) {
    const nextPromise = this.writePromise.then(async () => {
      try {
        return await callback();
      } catch (err) {
        throw err;
      }
    });
    this.writePromise = nextPromise.catch(() => {}); // Catch errors to prevent lock chain from breaking
    return nextPromise;
  }

  async init() {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;
    
    this.initPromise = (async () => {
      try {
        this.db = await SQLite.openDatabaseAsync(this.dbName);
        await this.db.execAsync('PRAGMA busy_timeout = 5000;');

        // Add write serialization queue to prevent parallel writes from lock contentions
        const originalRunAsync = this.db.runAsync.bind(this.db);
        const originalExecAsync = this.db.execAsync.bind(this.db);
        const originalWithExclusiveTransactionAsync = this.db.withExclusiveTransactionAsync.bind(this.db);
        const originalWithTransactionAsync = this.db.withTransactionAsync.bind(this.db);

        this.db.runAsync = (...args) => this.executeWrite(() => originalRunAsync(...args));
        this.db.execAsync = (...args) => this.executeWrite(() => originalExecAsync(...args));
        this.db.withExclusiveTransactionAsync = (...args) => this.executeWrite(() => originalWithExclusiveTransactionAsync(...args));
        this.db.withTransactionAsync = (...args) => this.executeWrite(() => originalWithTransactionAsync(...args));

      // Create base table if not exists (Version 1)
      await this.db.execAsync(`
        CREATE TABLE IF NOT EXISTS MediaAsset (
          id TEXT PRIMARY KEY,
          hash TEXT,
          isLocal INTEGER NOT NULL DEFAULT 0,
          hasGeo INTEGER NOT NULL DEFAULT 0,
          latitude REAL DEFAULT 0.0,
          longitude REAL DEFAULT 0.0,
          createTime INTEGER DEFAULT 0,
          mediaType TEXT,
          filename TEXT,
          isFavorite INTEGER DEFAULT 0,
          localCachePath TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_isLocal_hasGeo ON MediaAsset(isLocal, hasGeo);
        CREATE INDEX IF NOT EXISTS idx_hasGeo ON MediaAsset(hasGeo);
      `);

      // Handle versioned migrations
      const { user_version } = await this.db.getFirstAsync('PRAGMA user_version');
      let currentVersion = user_version;

      if (currentVersion < 1) {
        // Fallback for legacy databases that were created before versioning
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN filename TEXT;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN mediaType TEXT;`); } catch (e) {}
        await this.db.execAsync('PRAGMA user_version = 1');
        currentVersion = 1;
      }

      if (currentVersion < 2) {
        // Version 2: Add hashModificationTime, uploaded, and AI metadata columns
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN hashModificationTime INTEGER;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN uploaded INTEGER DEFAULT 0;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN metadata TEXT DEFAULT '';`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN classifyVersion INTEGER;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN textVersion INTEGER;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN faceRecVersion INTEGER;`); } catch (e) {}
        
        await this.db.execAsync('PRAGMA user_version = 2');
        currentVersion = 2;
        console.log('[AssetDBService] Database migrated to version 2.');
      }

      if (currentVersion < 3) {
        // Version 3: Add isFavorite and localCachePath columns for offline viewing
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN isFavorite INTEGER DEFAULT 0;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN localCachePath TEXT;`); } catch (e) {}
        
        await this.db.execAsync('PRAGMA user_version = 3');
        currentVersion = 3;
        console.log('[AssetDBService] Database migrated to version 3 (Added Favorites support).');
      }

      if (currentVersion < 4) {
        // Version 4: Add clipEmbeddingVersion and clipEmbedding columns for AI search
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN clipEmbeddingVersion INTEGER;`); } catch (e) {}
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN clipEmbedding TEXT;`); } catch (e) {}
        
        await this.db.execAsync('PRAGMA user_version = 4');
        currentVersion = 4;
        console.log('[AssetDBService] Database migrated to version 4 (Added CLIP Embedding support).');
      }

      if (currentVersion < 5) {
        // Version 5: Add phash column for perceptual hashing similar photos
        try { await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN phash TEXT;`); } catch (e) {}
        
        await this.db.execAsync('PRAGMA user_version = 5');
        currentVersion = 5;
        console.log('[AssetDBService] Database migrated to version 5 (Added pHash support).');
      }

      if (currentVersion < 6) {
        // Version 6: Add IgnoredDuplicate table for dismissing duplicate recommendations
        try {
          await this.db.execAsync(`
            CREATE TABLE IF NOT EXISTS IgnoredDuplicate (
              assetId TEXT PRIMARY KEY
            );
          `);
        } catch (e) {
          console.warn('[AssetDBService] Failed to create IgnoredDuplicate table:', e.message);
        }
        await this.db.execAsync('PRAGMA user_version = 6');
        currentVersion = 6;
        console.log('[AssetDBService] Database migrated to version 6 (Added IgnoredDuplicate support).');
      }

      // Smooth migration: if local_hash_cache_v2.json exists, migrate it to SQLite
      await this.migrateLocalHashCache();

      console.log(`[AssetDBService] Database initialized successfully (v${currentVersion}).`);
      } catch (error) {
        console.error('[AssetDBService] Failed to initialize DB:', error);
        throw error;
      } finally {
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  async migrateLocalHashCache() {
    try {
      const docDir = FileSystem.documentDirectory;
      if (!docDir) return;
      const path = docDir + (docDir.endsWith('/') ? '' : '/') + 'merkle/local_hash_cache_v2.json';
      const info = await FileSystem.getInfoAsync(path);
      
      if (info.exists) {
        console.log('[AssetDBService] Found legacy local_hash_cache_v2.json, migrating to SQLite...');
        const data = await FileSystem.readAsStringAsync(path);
        const cache = JSON.parse(data);
        const entries = Object.entries(cache);
        
        if (entries.length > 0) {
          await this.db.withExclusiveTransactionAsync(async () => {
            const statement = await this.db.prepareAsync(`
              UPDATE MediaAsset 
              SET hash = ?, hashModificationTime = ? 
              WHERE id = ? AND isLocal = 1
            `);
            try {
              let count = 0;
              for (const [id, value] of entries) {
                if (value && value.hash && value.modificationTime) {
                  statement.executeSync(value.hash, value.modificationTime, id);
                  count++;
                  if (count % 500 === 0) await new Promise(resolve => setTimeout(resolve, 5));
                }
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
          console.log(`[AssetDBService] Successfully migrated ${entries.length} hashes to DB.`);
        }
        
        // Delete the file after migration
        await FileSystem.deleteAsync(path);
        console.log('[AssetDBService] Deleted legacy local_hash_cache_v2.json');
      }
    } catch (e) {
      console.warn('[AssetDBService] Failed to migrate local hash cache:', e);
    }
  }

  async getLocalHashesMap() {
    if (!this.db) return {};
    const rows = await this.db.getAllAsync('SELECT id, hash, hashModificationTime, uploaded FROM MediaAsset WHERE isLocal = 1 AND hash IS NOT NULL');
    const map = {};
    for (const row of rows) {
      map[row.id] = { 
        hash: row.hash, 
        modificationTime: row.hashModificationTime,
        uploaded: row.uploaded === 1
      };
    }
    return map;
  }

  async updateAssetHash(id, hash, modificationTime) {
    if (!this.db) return;
    await this.db.runAsync(
      'UPDATE MediaAsset SET hash = ?, hashModificationTime = ? WHERE id = ?',
      [hash, modificationTime, id]
    );
  }

  async markAssetUploaded(id) {
    if (!this.db) return;
    await this.db.runAsync(
      'UPDATE MediaAsset SET uploaded = 1 WHERE id = ?',
      [id]
    );
  }

  async syncUploadedStatus() {
    if (!this.db) return;
    return await MetricsTracker.measure('AssetDBService_syncUploadedStatus', async () => {
      try {
        await this.db.withExclusiveTransactionAsync(async () => {
          // 1. Mark as uploaded if the hash exists in the remote assets (isLocal = 0)
          await this.db.execAsync(`
            UPDATE MediaAsset 
            SET uploaded = 1 
            WHERE isLocal = 1 
              AND hash IN (SELECT hash FROM MediaAsset WHERE isLocal = 0);
          `);
          
          // 2. Mark as NOT uploaded if the hash does not exist in remote assets
          await this.db.execAsync(`
            UPDATE MediaAsset 
            SET uploaded = 0 
            WHERE isLocal = 1 
              AND hash IS NOT NULL
              AND hash NOT IN (SELECT hash FROM MediaAsset WHERE isLocal = 0);
          `);
        });
        console.log('[AssetDBService] Successfully synced uploaded status within SQLite.');
      } catch (error) {
        console.error('[AssetDBService] Failed to sync uploaded status:', error);
      }
    });
  }

  // Insert or update local assets.
  // We use ON CONFLICT DO UPDATE so we don't duplicate or overwrite existing hashes/metadata.
  async insertLocalAssets(assets) {
    if (!this.db || !assets || assets.length === 0) return;

    return await MetricsTracker.measure('AssetDBService_insertLocalAssets', async () => {
      try {
        // Using a transaction for batch insert
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync(`
            INSERT INTO MediaAsset 
            (id, isLocal, hasGeo, latitude, longitude, createTime, mediaType) 
            VALUES (?, 1, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              hasGeo = excluded.hasGeo,
              latitude = excluded.latitude,
              longitude = excluded.longitude,
              createTime = excluded.createTime,
              mediaType = excluded.mediaType
          `);
          
          try {
            let counter = 0;
            for (const asset of assets) {
              // If the asset has location data, we mark hasGeo = 1
              const hasGeo = (asset.location && asset.location.latitude) ? 1 : 0;
              const lat = asset.location?.latitude || 0.0;
              const lon = asset.location?.longitude || 0.0;
              
              statement.executeSync(
                asset.id,
                hasGeo,
                lat,
                lon,
                asset.creationTime || 0,
                asset.mediaType || 'photo'
              );

              if (++counter % 500 === 0) {
                  await new Promise(resolve => setTimeout(resolve, 5));
              }
            }
          } finally {
            await statement.finalizeAsync();
          }
        });
        console.log(`[AssetDBService] Inserted ${assets.length} local assets.`);
      } catch (error) {
        console.error('[AssetDBService] Failed to insert local assets:', error);
        throw error;
      }
    }, `(Assets: ${assets.length})`);
  }

  // Sync remote assets discovered via SyncService
  async syncRemoteAssets(assets) {
    if (!this.db || !assets) return;

    const isVideoExtension = (filename) => {
      if (!filename) return false;
      const ext = filename.split('.').pop().toLowerCase();
      return ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext);
    };

    return await MetricsTracker.measure('AssetDBService_syncRemoteAssets', async () => {
      try {
        // 1. Get all existing IDs in SQLite database
        const existingRows = await this.db.getAllAsync('SELECT id FROM MediaAsset WHERE isLocal = 0');
        const existingIds = new Set(existingRows.map(r => r.id));
        
        // The new remote hashes from the server
        const incomingHashes = new Set(assets.map(a => a.hash));

        // 2. Find assets to delete (exist in DB but not in incoming)
        const idsToDelete = [...existingIds].filter(id => !incomingHashes.has(id));

        // 3. Find assets to insert (in incoming but not in DB)
        const newAssets = assets.filter(asset => !existingIds.has(asset.hash));

        if (idsToDelete.length > 0) {
          console.log(`[AssetDBService] Deleting ${idsToDelete.length} stale remote assets...`);
          await this.db.withExclusiveTransactionAsync(async () => {
            const statement = await this.db.prepareAsync('DELETE FROM MediaAsset WHERE id = ? AND isLocal = 0');
            try {
              let counter = 0;
              for (const id of idsToDelete) {
                statement.executeSync(id);
                if (++counter % 500 === 0) await new Promise(resolve => setTimeout(resolve, 5));
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
        }

        if (newAssets.length > 0) {
          console.log(`[AssetDBService] Inserting ${newAssets.length} new remote assets out of ${assets.length}...`);
          await this.db.withExclusiveTransactionAsync(async () => {
            const statement = await this.db.prepareAsync(`
              INSERT OR IGNORE INTO MediaAsset 
              (id, hash, isLocal, hasGeo, latitude, longitude, createTime, mediaType, filename) 
              VALUES (?, ?, 0, 0, 0.0, 0.0, ?, ?, ?)
            `);
            
            try {
              let counter = 0;
              for (const asset of newAssets) {
                const id = asset.hash;
                let createTime = 0;
                if (asset.date) {
                  createTime = new Date(asset.date).getTime();
                }
                const filename = asset.tag || asset.filename || '';
                const mType = isVideoExtension(filename) ? 'video' : 'photo';
                statement.executeSync(
                  id,
                  asset.hash,
                  createTime,
                  mType,
                  filename
                );

                if (++counter % 500 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
          console.log(`[AssetDBService] Inserted ${newAssets.length} remote assets.`);
        }
      } catch (error) {
        console.error('[AssetDBService] Failed to sync remote assets:', error);
        throw error;
      }
    }, `(Assets: ${assets.length})`);
  }

  // Get remote assets that need their GPS data fetched
  async getRemoteAssetsWithoutGeo(limit = 100) {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT id, hash FROM MediaAsset WHERE isLocal = 0 AND hasGeo = 0 LIMIT ?`,
        [limit]
      );
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get remote assets without geo:', error);
      return [];
    }
  }

  // Get local assets that need their GPS data fetched/resolved
  async getLocalAssetsWithoutGeo(limit = 100) {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT id FROM MediaAsset WHERE isLocal = 1 AND hasGeo = 0 LIMIT ?`,
        [limit]
      );
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get local assets without geo:', error);
      return [];
    }
  }

  // Batch update GPS data for remote assets
  async updateAssetsGeo(updates) {
    if (!this.db || !updates || updates.length === 0) return;

    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync(`
          UPDATE MediaAsset SET hasGeo = 1, latitude = ?, longitude = ? WHERE id = ?
        `);
        try {
          for (const update of updates) {
            await statement.executeAsync(
              update.latitude || 0.0,
              update.longitude || 0.0,
              update.id
            );
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
      console.log(`[AssetDBService] Updated geo for ${updates.length} assets.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to update assets geo:', error);
    }
  }

  // Mark assets as processed (hasGeo = 1) even if they don't have GPS
  // This prevents us from querying the server repeatedly for assets that just don't have location
  async markAssetsGeoProcessed(ids) {
    if (!this.db || !ids || ids.length === 0) return;

    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync(`
          UPDATE MediaAsset SET hasGeo = 1 WHERE id = ?
        `);
        try {
          for (const id of ids) {
            await statement.executeAsync(id);
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
    } catch (error) {
      console.error('[AssetDBService] Failed to mark assets geo processed:', error);
    }
  }

  // Get all assets that have valid geo coordinates (for the Photo Map)
  async getAssetsWithGeo() {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT id, isLocal, latitude, longitude, hash, mediaType FROM MediaAsset WHERE hasGeo = 1 AND latitude != 0 AND longitude != 0`
      );
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get assets with geo:', error);
      return [];
    }
  }

  // Get all remote assets from SQLite database for rendering in the gallery
  async getRemoteAssets() {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT hash, filename, createTime, mediaType, isFavorite, localCachePath FROM MediaAsset WHERE isLocal = 0 ORDER BY createTime DESC`
      );
      return rows.map(r => ({
        id: `remote-${r.hash}`,
        hash: r.hash,
        filename: r.filename,
        creationTime: r.createTime || 0,
        mediaType: r.mediaType || 'photo',
        isFavorite: r.isFavorite === 1,
        localCachePath: r.localCachePath
      }));
    } catch (error) {
      console.error('[AssetDBService] Failed to get remote assets:', error);
      return [];
    }
  }

  async getAssetsByHashes(hashes) {
    if (!this.db || !hashes || hashes.length === 0) return [];
    try {
      const results = [];
      const CHUNK_SIZE = 400; // SQLite limit is usually 999 vars
      for (let i = 0; i < hashes.length; i += CHUNK_SIZE) {
        const chunk = hashes.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const bindArgs = chunk.map(h => h.toLowerCase());
        
        const rows = await this.db.getAllAsync(
          `SELECT hash, filename, createTime, mediaType, isFavorite, localCachePath 
           FROM MediaAsset 
           WHERE hash IN (${placeholders}) OR id IN (${placeholders})
           ORDER BY createTime DESC`,
          bindArgs.concat(bindArgs)
        );
        
        if (rows) {
          results.push(...rows.map(r => ({
            id: r.hash,
            hash: r.hash,
            filename: r.filename,
            creationTime: r.createTime,
            mediaType: r.mediaType,
            isFavorite: Boolean(r.isFavorite),
            localCachePath: r.localCachePath
          })));
        }
      }
      return results;
    } catch (e) {
      console.error('[AssetDB] getAssetsByHashes error', e);
      return [];
    }
  }

  // Get total count of remote assets in SQLite database
  async getRemoteAssetsCount() {
    if (!this.db) return 0;
    try {
      const result = await this.db.getFirstAsync(
        `SELECT COUNT(*) as count FROM MediaAsset WHERE isLocal = 0`
      );
      return result ? result.count : 0;
    } catch (error) {
      console.error('[AssetDBService] Failed to get remote assets count:', error);
      return 0;
    }
  }

  // Batch update remote assets' filename and mediaType (data healer)
  async updateRemoteAssetFilenames(updates) {
    if (!this.db || !updates || updates.length === 0) return;

    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync(`
          UPDATE MediaAsset SET filename = ?, mediaType = ? WHERE id = ?
         `);
         try {
           for (const update of updates) {
             await statement.executeAsync(
               update.filename,
               update.mediaType,
               update.hash
             );
           }
         } finally {
           await statement.finalizeAsync();
         }
      });
      console.log(`[AssetDBService] Healed filenames for ${updates.length} remote assets.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to update remote asset filenames:', error);
    }
  }

  /**
   * Sets the favorite status of an asset by hash.
   * @param {string} hash - The SHA1 hash of the asset.
   * @param {boolean} isFavorite - The desired favorite status.
   */
  async setAssetFavoriteStatus(hash, isFavorite) {
    if (!this.db) return;
    try {
      await this.db.runAsync(
        `UPDATE MediaAsset SET isFavorite = ? WHERE hash = ?`,
        [isFavorite ? 1 : 0, hash]
      );
    } catch (e) {
      console.error(`Failed to update favorite status for ${hash}:`, e);
    }
  }

  /**
   * Synchronizes the favorite status from the server to the local database.
   * @param {Array<string>} favHashes - Array of asset hashes that are currently favorited on the server.
   */
  async syncFavoriteStatus(favHashes) {
    if (!this.db) return;
    try {
      // 1. Reset all remote assets to not favorite
      await this.db.execAsync(`UPDATE MediaAsset SET isFavorite = 0 WHERE isLocal = 0`);
      
      // 2. Set the favorited ones in chunks of 500 to avoid SQLite parameter limits
      if (favHashes && favHashes.length > 0) {
        for (let i = 0; i < favHashes.length; i += 500) {
          const chunk = favHashes.slice(i, i + 500);
          const placeholders = chunk.map(() => '?').join(',');
          await this.db.runAsync(
            `UPDATE MediaAsset SET isFavorite = 1 WHERE hash IN (${placeholders}) AND isLocal = 0`,
            chunk
          );
        }
      }
    } catch (e) {
      console.error(`[AssetDBService] Failed to sync favorite status:`, e);
    }
  }

  // --- Offline Favorites Caching ---

  async updateAssetCachePath(hash, localCachePath) {
    if (!this.db) return;
    try {
      await this.db.runAsync(
        `UPDATE MediaAsset SET localCachePath = ? WHERE id = ?`,
        [localCachePath, hash]
      );
    } catch (error) {
      console.error(`[AssetDBService] Failed to update cache path for ${hash}:`, error);
    }
  }

  async getFavoriteAssetsToCache() {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT hash, filename, mediaType FROM MediaAsset WHERE isLocal = 0 AND isFavorite = 1 AND localCachePath IS NULL`
      );
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get favorite assets to cache:', error);
      return [];
    }
  }

  async getFavoriteAssets() {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(
        `SELECT hash, filename, localCachePath FROM MediaAsset WHERE isLocal = 0 AND isFavorite = 1`
      );
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get favorite assets:', error);
      return [];
    }
  }

  async getRemoteAssetDetails(hash) {
    if (!this.db) return null;
    try {
      return await this.db.getFirstAsync(
        `SELECT isFavorite, localCachePath FROM MediaAsset WHERE id = ?`,
        [hash]
      );
    } catch (error) {
      console.error(`[AssetDBService] Failed to get details for ${hash}:`, error);
      return null;
    }
  }

  async deleteAsset(idOrHash) {
    if (!this.db) return;
    try {
      console.log(`[AssetDBService] Deleting asset from SQLite: ${idOrHash}`);
      await this.db.runAsync(
        'DELETE FROM MediaAsset WHERE id = ? OR hash = ?',
        [idOrHash, idOrHash]
      );
    } catch (error) {
      console.error('[AssetDBService] Failed to delete asset from SQLite:', error);
    }
  }

  // Get all assets with a valid phash for duplicate detection (excluding ignored ones)
  async getAssetsWithPHash() {
    if (!this.db) return [];
    try {
      const rows = await this.db.getAllAsync(`
        SELECT id, hash, isLocal, filename, createTime, mediaType, phash, localCachePath, metadata 
        FROM MediaAsset 
        WHERE phash IS NOT NULL AND phash != "" AND phash != "failed" AND phash != "none"
          AND id NOT IN (SELECT assetId FROM IgnoredDuplicate)
          AND (hash IS NULL OR hash NOT IN (SELECT assetId FROM IgnoredDuplicate))
        ORDER BY createTime DESC
      `);
      return rows;
    } catch (error) {
      console.error('[AssetDBService] Failed to get assets with phash:', error);
      return [];
    }
  }

  // Mark assets as ignored so they don't show up in duplicate list
  async ignoreAssetsForDuplicates(assetIds) {
    if (!this.db || !assetIds || assetIds.length === 0) return;
    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync('INSERT OR IGNORE INTO IgnoredDuplicate (assetId) VALUES (?)');
        try {
          for (const id of assetIds) {
            if (id) statement.executeSync(id);
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
      console.log(`[AssetDBService] Ignored ${assetIds.length} assets for duplicates.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to ignore assets for duplicates:', error);
    }
  }

  // Bulk delete assets from SQLite database in a single transaction
  async deleteAssets(idsOrHashes) {
    if (!this.db || !idsOrHashes || idsOrHashes.length === 0) return;
    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync('DELETE FROM MediaAsset WHERE id = ? OR hash = ?');
        try {
          for (const id of idsOrHashes) {
            if (id) statement.executeSync(id, id);
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
      console.log(`[AssetDBService] Bulk deleted ${idsOrHashes.length} assets from SQLite.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to bulk delete assets from SQLite:', error);
    }
  }
}

export default new AssetDBService();
