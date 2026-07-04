import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import MetricsTracker from '../utils/MetricsTracker';
import { pinyin } from 'pinyin-pro';

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
      let db = null;
      try {
        db = await SQLite.openDatabaseAsync(this.dbName);
        await db.execAsync('PRAGMA busy_timeout = 30000;');
        await db.execAsync('PRAGMA journal_mode = WAL;');

        // Add write serialization queue to prevent parallel writes from lock contentions
        const originalRunAsync = db.runAsync.bind(db);
        const originalExecAsync = db.execAsync.bind(db);
        const originalWithExclusiveTransactionAsync = db.withExclusiveTransactionAsync.bind(db);
        const originalWithTransactionAsync = db.withTransactionAsync.bind(db);

        db.runAsync = (...args) => this.executeWrite(() => originalRunAsync(...args));
        db.execAsync = (...args) => this.executeWrite(() => originalExecAsync(...args));
        db.withExclusiveTransactionAsync = (...args) => this.executeWrite(() => originalWithExclusiveTransactionAsync(...args));
        db.withTransactionAsync = (...args) => this.executeWrite(() => originalWithTransactionAsync(...args));

      // Create base table if not exists (Version 1)
      await db.execAsync(`
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
          localCachePath TEXT,
          phash TEXT,
          clipEmbedding TEXT
        );
      `);
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_isLocal_hasGeo ON MediaAsset(isLocal, hasGeo);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_hasGeo ON MediaAsset(hasGeo);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_hash ON MediaAsset(hash);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_isLocal ON MediaAsset(isLocal);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_phash ON MediaAsset(phash);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_clipEmbedding ON MediaAsset(clipEmbedding);'); } catch (e) {}
      try { await db.execAsync('CREATE INDEX IF NOT EXISTS idx_createTime ON MediaAsset(createTime);'); } catch (e) {}

      // Handle versioned migrations
      const { user_version } = await db.getFirstAsync('PRAGMA user_version');
      let currentVersion = user_version;

      if (currentVersion < 1) {
        // Fallback for legacy databases that were created before versioning
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN filename TEXT;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN mediaType TEXT;`); } catch (e) {}
        await db.execAsync('PRAGMA user_version = 1');
        currentVersion = 1;
      }

      if (currentVersion < 2) {
        // Version 2: Add hashModificationTime, uploaded, and AI metadata columns
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN hashModificationTime INTEGER;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN uploaded INTEGER DEFAULT 0;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN metadata TEXT DEFAULT '';`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN classifyVersion INTEGER;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN textVersion INTEGER;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN faceRecVersion INTEGER;`); } catch (e) {}
        
        await db.execAsync('PRAGMA user_version = 2');
        currentVersion = 2;
        console.log('[AssetDBService] Database migrated to version 2.');
      }

      if (currentVersion < 3) {
        // Version 3: Add isFavorite and localCachePath columns for offline viewing
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN isFavorite INTEGER DEFAULT 0;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN localCachePath TEXT;`); } catch (e) {}
        
        await db.execAsync('PRAGMA user_version = 3');
        currentVersion = 3;
        console.log('[AssetDBService] Database migrated to version 3 (Added Favorites support).');
      }

      if (currentVersion < 4) {
        // Version 4: Add clipEmbeddingVersion and clipEmbedding columns for AI search
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN clipEmbeddingVersion INTEGER;`); } catch (e) {}
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN clipEmbedding TEXT;`); } catch (e) {}
        
        await db.execAsync('PRAGMA user_version = 4');
        currentVersion = 4;
        console.log('[AssetDBService] Database migrated to version 4 (Added CLIP Embedding support).');
      }

      if (currentVersion < 5) {
        // Version 5: Add phash column for perceptual hashing similar photos
        try { await db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN phash TEXT;`); } catch (e) {}
        
        await db.execAsync('PRAGMA user_version = 5');
        currentVersion = 5;
        console.log('[AssetDBService] Database migrated to version 5 (Added pHash support).');
      }

      if (currentVersion < 6) {
        // Version 6: Add IgnoredDuplicate table for dismissing duplicate recommendations
        try {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS IgnoredDuplicate (
              assetId TEXT PRIMARY KEY
            );
          `);
        } catch (e) {
          console.warn('[AssetDBService] Failed to create IgnoredDuplicate table:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 6');
        currentVersion = 6;
        console.log('[AssetDBService] Database migrated to version 6 (Added IgnoredDuplicate support).');
      }

      if (currentVersion < 7) {
        // Version 7: Add index on hash and index on isLocal for fast lookups/updates
        try {
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_hash ON MediaAsset(hash);');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_isLocal ON MediaAsset(isLocal);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to create idx_hash or idx_isLocal indexes:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 7');
        currentVersion = 7;
        console.log('[AssetDBService] Database migrated to version 7 (Added hash and isLocal indexes).');
      }

      if (currentVersion < 8) {
        // Version 8: Add indexes on phash and clipEmbedding for fast background indexing queries
        try {
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_phash ON MediaAsset(phash);');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_clipEmbedding ON MediaAsset(clipEmbedding);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to create idx_phash or idx_clipEmbedding indexes:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 8');
        currentVersion = 8;
        console.log('[AssetDBService] Database migrated to version 8 (Added phash and clipEmbedding indexes).');
      }

      if (currentVersion < 9) {
        // Version 9: Add ocrText column for OCR full text search and caching
        try {
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN ocrText TEXT;');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_ocrText ON MediaAsset(ocrText);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to add ocrText column or index:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 9');
        currentVersion = 9;
        console.log('[AssetDBService] Database migrated to version 9 (Added ocrText column).');
      }

      if (currentVersion < 10) {
        // Version 10: Add reverse geocoding columns for hybrid search
        try {
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN locationCity TEXT;');
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN locationState TEXT;');
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN locationCountry TEXT;');
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN locationChecked INTEGER DEFAULT 0;');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_locationCity ON MediaAsset(locationCity);');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_locationChecked ON MediaAsset(locationChecked);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to migrate database to version 10:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 10');
        currentVersion = 10;
        console.log('[AssetDBService] Database migrated to version 10 (Added location columns).');
      }

      if (currentVersion < 11) {
        // Version 11: Add index on createTime to speed up date-range queries
        try {
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_createTime ON MediaAsset(createTime);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to migrate database to version 11:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 11');
        currentVersion = 11;
        console.log('[AssetDBService] Database migrated to version 11 (Added idx_createTime index).');
      }

      if (currentVersion < 12) {
        // Version 12: Add locationPinyin for location search support
        try {
          await db.execAsync('ALTER TABLE MediaAsset ADD COLUMN locationPinyin TEXT;');
          await db.execAsync('CREATE INDEX IF NOT EXISTS idx_locationPinyin ON MediaAsset(locationPinyin);');
        } catch (e) {
          console.warn('[AssetDBService] Failed to migrate database to version 12:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 12');
        currentVersion = 12;
        console.log('[AssetDBService] Database migrated to version 12 (Added locationPinyin).');
      }

      if (currentVersion < 13) {
        // Version 13: One-time repair of remote asset createTime values that were incorrectly
        // stamped with Date.now() due to a field name mismatch (asset.creationTime was undefined
        // for MerkleNode objects, causing the || Date.now() fallback to fire).
        // Any remote asset whose createTime is within the last 30 days is suspect — reset it to 0
        // so the next sync will write the correct date from the server.
        try {
          const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
          const result = await db.runAsync(
            `UPDATE MediaAsset SET createTime = 0 WHERE isLocal = 0 AND createTime > ?`,
            [thirtyDaysAgo]
          );
          console.log(`[AssetDBService] v13 migration: reset ${result.changes} remote assets with bad createTime.`);
        } catch (e) {
          console.warn('[AssetDBService] Failed to migrate database to version 13:', e.message);
        }
        await db.execAsync('PRAGMA user_version = 13');
        currentVersion = 13;
        console.log('[AssetDBService] Database migrated to version 13 (Repaired remote createTime).');
      }

      // Smooth migration: if local_hash_cache_v2.json exists, migrate it to SQLite
      await this.migrateLocalHashCache(db);

      // Backfill missing location pinyins
      this.backfillLocationPinyin(db).catch(e => console.error('[AssetDBService] backfill failed:', e));

      this.db = db;
      console.log(`[AssetDBService] Database initialized successfully (v${currentVersion}).`);
      } catch (error) {
        this.db = null;
        if (db) {
          try {
            await db.closeAsync();
            console.log('[AssetDBService] Closed database connection after failed initialization.');
          } catch (closeError) {
            console.error('[AssetDBService] Failed to close database after initialization failure:', closeError);
          }
        }
        console.error('[AssetDBService] Failed to initialize DB:', error);
        throw error;
      } finally {
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  async migrateLocalHashCache(db) {
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
          const chunkSize = 100;
          for (let i = 0; i < entries.length; i += chunkSize) {
            const chunk = entries.slice(i, i + chunkSize);
            await db.withExclusiveTransactionAsync(async () => {
              const statement = await db.prepareAsync(`
                UPDATE MediaAsset 
                SET hash = ?, hashModificationTime = ? 
                WHERE id = ? AND isLocal = 1
              `);
              try {
                for (const [id, value] of chunk) {
                  if (value && value.hash && value.modificationTime) {
                    statement.executeSync(value.hash, Math.floor(value.modificationTime), id);
                  }
                }
              } finally {
                await statement.finalizeAsync();
              }
            });
            if (i + chunkSize < entries.length) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
          console.log(`[AssetDBService] Successfully migrated ${entries.length} hashes to DB.`);
        }
        
        // Delete the file after migration
        await FileSystem.deleteAsync(path);
        console.log(`[AssetDBService] Successfully migrated local_hash_cache_v2 to SQLite.`);
      }
    } catch (e) {
      console.error('[AssetDBService] Error migrating local_hash_cache:', e);
    }
  }

  async backfillLocationPinyin(db) {
    try {
      const rows = await db.getAllAsync(`
        SELECT id, locationCity, locationState, locationCountry 
        FROM MediaAsset 
        WHERE locationPinyin IS NULL AND locationCity IS NOT NULL
      `);
      if (rows && rows.length > 0) {
        console.log(`[AssetDBService] Found ${rows.length} assets missing location pinyin. Backfilling...`);
        const chunkSize = 100;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          await db.withExclusiveTransactionAsync(async () => {
            const statement = await db.prepareAsync(`
              UPDATE MediaAsset 
              SET locationPinyin = ? 
              WHERE id = ?
            `);
            try {
              for (const row of chunk) {
                const combined = [row.locationCity, row.locationState, row.locationCountry].filter(Boolean).join(' ');
                // Convert to pinyin array and join without spaces (e.g. "武汉" -> "wuhan")
                const p = pinyin(combined, { toneType: 'none', type: 'array' }).join('');
                statement.executeSync([p, row.id]);
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
        }
        console.log('[AssetDBService] Backfill locationPinyin complete.');
      }
    } catch (e) {
      console.error('[AssetDBService] Error during backfillLocationPinyin:', e);
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

  // Get total count of assets
  async getAssetCount() {
    if (!this.db) return 0;
    try {
      const result = await this.db.getFirstAsync('SELECT COUNT(*) as count FROM MediaAsset');
      return result ? result.count : 0;
    } catch (e) {
      console.error('[AssetDBService] Failed to get asset count:', e);
      return 0;
    }
  }

  async updateAssetHash(id, hash, modificationTime) {
    if (!this.db) return;
    // expo-media-library returns modificationTime as a float (seconds since epoch).
    // SQLite INTEGER truncates floats, so we floor it explicitly to keep the stored
    // value consistent with what we'll compare against on the next launch.
    await this.db.runAsync(
      'UPDATE MediaAsset SET hash = ?, hashModificationTime = ? WHERE id = ?',
      [hash, Math.floor(modificationTime), id]
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
        console.log('[AssetDBService] Successfully synced uploaded status within SQLite.');
      } catch (error) {
        console.error('[AssetDBService] Failed to sync uploaded status:', error);
      }
    });
  }

  // Batch save perceptual hashes (pHashes) in a single transaction
  async saveAssetPHashesBatch(updates) {
    if (!this.db || !updates || updates.length === 0) return;
    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync(
          'UPDATE MediaAsset SET phash = ? WHERE id = ? OR hash = ?'
        );
        try {
          for (const update of updates) {
            statement.executeSync(update.phash, update.idOrHash, update.idOrHash);
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
      console.log(`[AssetDBService] Batch saved ${updates.length} pHashes.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to batch save pHashes:', error);
    }
  }

  // Batch save embeddings in a single transaction
  async saveAssetEmbeddingsBatch(updates) {
    if (!this.db || !updates || updates.length === 0) return;
    try {
      await this.db.withExclusiveTransactionAsync(async () => {
        const statement = await this.db.prepareAsync(
          'UPDATE MediaAsset SET clipEmbedding = ?, clipEmbeddingVersion = ? WHERE id = ? OR hash = ?'
        );
        try {
          for (const update of updates) {
            statement.executeSync(update.embedding, update.version, update.idOrHash, update.idOrHash);
          }
        } finally {
          await statement.finalizeAsync();
        }
      });
      console.log(`[AssetDBService] Batch saved ${updates.length} embeddings.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to batch save embeddings:', error);
    }
  }

  // Insert or update local assets.
  // We use ON CONFLICT DO UPDATE so we don't duplicate or overwrite existing hashes/metadata.
  async insertLocalAssets(assets) {
    if (!this.db || !assets || assets.length === 0) return;

    return await MetricsTracker.measure('AssetDBService_insertLocalAssets', async () => {
      try {
        const chunkSize = 100;
        for (let i = 0; i < assets.length; i += chunkSize) {
          const chunk = assets.slice(i, i + chunkSize);
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
              for (const asset of chunk) {
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
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
          
          if (i + chunkSize < assets.length) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
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

        if (idsToDelete.length > 0) {
          console.log(`[AssetDBService] Deleting ${idsToDelete.length} stale remote assets...`);
          const chunkSize = 500;
          for (let i = 0; i < idsToDelete.length; i += chunkSize) {
            const chunk = idsToDelete.slice(i, i + chunkSize);
            await this.db.withExclusiveTransactionAsync(async () => {
              const statement = await this.db.prepareAsync('DELETE FROM MediaAsset WHERE id = ? AND isLocal = 0');
              try {
                for (const id of chunk) {
                  statement.executeSync(id);
                }
              } finally {
                await statement.finalizeAsync();
              }
            });
            if (i + chunkSize < idsToDelete.length) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
        }

        // 3. Get existing remote assets that need repair (reset to 0 by migration v13 or corrupted)
        const repairRows = await this.db.getAllAsync('SELECT id FROM MediaAsset WHERE isLocal = 0 AND (createTime = 0 OR createTime IS NULL)');
        const repairIds = new Set(repairRows.map(r => r.id));

        // Insert only genuinely new assets (those not already in the DB).
        // Existing rows are left untouched to preserve GPS, isFavorite, localCachePath, and AI embeddings.
        const newAssets = assets.filter(asset => !existingIds.has(asset.hash));
        
        // Find existing assets from the server that need their timestamps repaired in SQLite
        const repairAssets = assets.filter(asset => repairIds.has(asset.hash));

        if (newAssets.length > 0) {
          console.log(`[AssetDBService] Inserting ${newAssets.length} new remote assets out of ${assets.length}...`);
          const chunkSize = 500;
          for (let i = 0; i < newAssets.length; i += chunkSize) {
            const chunk = newAssets.slice(i, i + chunkSize);
            await this.db.withExclusiveTransactionAsync(async () => {
              const statement = await this.db.prepareAsync(`
                INSERT OR IGNORE INTO MediaAsset 
                (id, hash, isLocal, hasGeo, latitude, longitude, createTime, mediaType, filename) 
                VALUES (?, ?, 0, 0, 0.0, 0.0, ?, ?, ?)
              `);
              try {
                for (const asset of chunk) {
                  // MerkleNode objects use `tag` for filename and `date` (a Date object) for creation time.
                  // Fall back to plain `filename`/`creationTime` fields for plain objects.
                  const filename = asset.tag || asset.filename || '';
                  const creationTime = asset.date ? asset.date.getTime() : (asset.creationTime || 0);
                  const mediaTypeStr = asset.mediaType || (isVideoExtension(filename) ? 'video' : 'photo');
                  statement.executeSync(
                    asset.hash,
                    asset.hash,
                    creationTime,
                    mediaTypeStr,
                    filename
                  );
                }
              } finally {
                await statement.finalizeAsync();
              }
            });
            if (i + chunkSize < newAssets.length) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
          console.log(`[AssetDBService] Inserted ${newAssets.length} remote assets.`);
        }

        // Repair timestamps for existing assets in a single batch
        if (repairAssets.length > 0) {
          console.log(`[AssetDBService] Repairing timestamps for ${repairAssets.length} existing remote assets...`);
          const chunkSize = 500;
          for (let i = 0; i < repairAssets.length; i += chunkSize) {
            const chunk = repairAssets.slice(i, i + chunkSize);
            await this.db.withExclusiveTransactionAsync(async () => {
              const statement = await this.db.prepareAsync(`
                UPDATE MediaAsset 
                SET createTime = ?, mediaType = ?, filename = ? 
                WHERE id = ? AND isLocal = 0
              `);
              try {
                for (const asset of chunk) {
                  const filename = asset.tag || asset.filename || '';
                  const creationTime = asset.date ? asset.date.getTime() : (asset.creationTime || 0);
                  const mediaTypeStr = asset.mediaType || (isVideoExtension(filename) ? 'video' : 'photo');
                  statement.executeSync(
                    creationTime,
                    mediaTypeStr,
                    filename,
                    asset.hash
                  );
                }
              } finally {
                await statement.finalizeAsync();
              }
            });
            if (i + chunkSize < repairAssets.length) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
          console.log(`[AssetDBService] Repaired ${repairAssets.length} remote asset timestamps.`);
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
      const chunkSize = 100;
      for (let i = 0; i < updates.length; i += chunkSize) {
        const chunk = updates.slice(i, i + chunkSize);
        console.log(`[AssetDBService] updateAssetsGeo entering withExclusiveTransactionAsync`);
        await this.db.withExclusiveTransactionAsync(async () => {
          console.log(`[AssetDBService] updateAssetsGeo transaction started`);
          const statement = await this.db.prepareAsync(`
            UPDATE MediaAsset SET hasGeo = 1, latitude = ?, longitude = ? WHERE id = ?
          `);
          try {
            for (const update of chunk) {
              // Use executeSync to prevent event loop yielding which causes deadlocks with concurrent transactions
              statement.executeSync(
                update.latitude || 0.0,
                update.longitude || 0.0,
                update.id
              );
            }
          } finally {
            console.log(`[AssetDBService] updateAssetsGeo transaction finalizing statement`);
            await statement.finalizeAsync();
            console.log(`[AssetDBService] updateAssetsGeo transaction finalized statement`);
          }
        });
        console.log(`[AssetDBService] updateAssetsGeo transaction finished`);
        // Yield to the JS event loop between chunks so React state updates (e.g. search tokens)
        // are not blocked by back-to-back GPS batch writes.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
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
      const chunkSize = 100;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        console.log(`[AssetDBService] markAssetsGeoProcessed entering withExclusiveTransactionAsync`);
        await this.db.withExclusiveTransactionAsync(async () => {
          console.log(`[AssetDBService] markAssetsGeoProcessed transaction started`);
          const statement = await this.db.prepareAsync(`
            UPDATE MediaAsset SET hasGeo = -1 WHERE id = ?
          `);
          try {
            for (const id of chunk) {
              // Use executeSync to prevent event loop yielding which causes deadlocks with concurrent transactions
              statement.executeSync(id);
            }
          } finally {
            console.log(`[AssetDBService] markAssetsGeoProcessed transaction finalizing`);
            await statement.finalizeAsync();
            console.log(`[AssetDBService] markAssetsGeoProcessed transaction finalized`);
          }
        });
        console.log(`[AssetDBService] markAssetsGeoProcessed transaction finished`);
        // Yield to the JS event loop between chunks.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.error('[AssetDBService] Failed to mark assets geo processed:', error);
    }
  }

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

  // Get assets created on this exact day in previous years (Memories / On This Day)
  async getOnThisDayAssets() {
    if (!this.db) return [];
    try {
      const now = new Date();
      const currentMonth = ('0' + (now.getMonth() + 1)).slice(-2);
      const currentDay = ('0' + now.getDate()).slice(-2);
      const currentYear = now.getFullYear();

      const query = `
        SELECT id, isLocal, hash, mediaType, createTime, filename 
        FROM MediaAsset 
        WHERE createTime > 0 
          AND strftime('%m-%d', createTime / 1000, 'unixepoch', 'localtime') = ?
          AND cast(strftime('%Y', createTime / 1000, 'unixepoch', 'localtime') as integer) < ?
        ORDER BY createTime DESC
        LIMIT 50
      `;
      const rows = await this.db.getAllAsync(query, [`${currentMonth}-${currentDay}`, currentYear]);
      return rows;
    } catch (e) {
      console.error('[AssetDBService] Failed to get On This Day assets:', e);
      return [];
    }
  }

  // Get safely backed up local videos for Large File Cleanup
  async getSafelyBackedUpVideos() {
    if (!this.db) return [];
    try {
      const query = `
        SELECT id, isLocal, hash, mediaType, createTime, filename 
        FROM MediaAsset 
        WHERE isLocal = 1 
          AND mediaType = 'video'
          AND uploaded = 1
        ORDER BY createTime DESC
      `;
      const rows = await this.db.getAllAsync(query);
      return rows;
    } catch (e) {
      console.error('[AssetDBService] Failed to get safely backed up videos:', e);
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
      const chunkSize = 500;
      for (let i = 0; i < updates.length; i += chunkSize) {
        const chunk = updates.slice(i, i + chunkSize);
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync(`
            UPDATE MediaAsset SET filename = ?, mediaType = ? WHERE id = ?
          `);
          try {
            for (const update of chunk) {
              statement.executeSync(
                update.filename,
                update.mediaType,
                update.hash
              );
            }
          } finally {
            await statement.finalizeAsync();
          }
        });
        if (i + chunkSize < updates.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      console.log(`[AssetDBService] Healed filenames for ${updates.length} remote assets.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to update remote asset filenames:', error);
    }
  }

  // Batch repair remote assets' createTime, filename, and mediaType
  async repairRemoteAssetTimestamps(updates) {
    if (!this.db || !updates || updates.length === 0) return;

    try {
      const chunkSize = 500;
      for (let i = 0; i < updates.length; i += chunkSize) {
        const chunk = updates.slice(i, i + chunkSize);
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync(`
            UPDATE MediaAsset SET createTime = ?, filename = ?, mediaType = ? WHERE id = ?
          `);
          try {
            for (const update of chunk) {
              statement.executeSync(
                update.creationTime,
                update.filename,
                update.mediaType,
                update.hash
              );
            }
          } finally {
            await statement.finalizeAsync();
          }
        });
        if (i + chunkSize < updates.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      console.log(`[AssetDBService] Repaired database timestamps for ${updates.length} remote assets.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to repair remote asset timestamps:', error);
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
      const chunkSize = 100;
      for (let i = 0; i < assetIds.length; i += chunkSize) {
        const chunk = assetIds.slice(i, i + chunkSize);
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync('INSERT OR IGNORE INTO IgnoredDuplicate (assetId) VALUES (?)');
          try {
            for (const id of chunk) {
              if (id) statement.executeSync(id);
            }
          } finally {
            await statement.finalizeAsync();
          }
        });
        if (i + chunkSize < assetIds.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      console.log(`[AssetDBService] Ignored ${assetIds.length} assets for duplicates.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to ignore assets for duplicates:', error);
    }
  }

  // Save OCR text extracted for an asset
  async saveAssetOCR(idOrHash, ocrText) {
    if (!this.db) return;
    try {
      await this.db.runAsync(
        'UPDATE MediaAsset SET ocrText = ? WHERE id = ? OR hash = ?',
        [ocrText, idOrHash, idOrHash]
      );
    } catch (error) {
      console.error('[AssetDBService] Failed to save asset OCR text:', error);
    }
  }

  // Save geocoded location for an asset
  async saveAssetLocation(id, location, locationPinyin) {
    if (!this.db) return;
    try {
      await this.db.runAsync(
        'UPDATE MediaAsset SET locationCity = ?, locationState = ?, locationCountry = ?, locationPinyin = ?, locationChecked = 1 WHERE id = ?',
        [location.city || null, location.region || null, location.country || null, locationPinyin || null, id]
      );
    } catch (error) {
      console.error('[AssetDBService] Failed to save asset location:', error);
    }
  }

  // Mark geocoding checked (failed or no coordinates)
  async markLocationChecked(id) {
    if (!this.db) return;
    try {
      await this.db.runAsync(
        'UPDATE MediaAsset SET locationChecked = 1 WHERE id = ?',
        [id]
      );
    } catch (error) {
      console.error('[AssetDBService] Failed to mark location checked:', error);
    }
  }

  // Fetch unique location suggestions matching text, or top 5 if text is empty
  async getLocationSuggestions(text) {
    if (!this.db) return [];
    try {
      if (!text || text.trim().length === 0) {
        // Return top 5 most frequent cities when search is empty
        const rows = await this.db.getAllAsync(`
          SELECT locationCity AS name, 'city' AS type 
          FROM MediaAsset 
          WHERE locationCity IS NOT NULL 
          GROUP BY locationCity 
          ORDER BY COUNT(*) DESC 
          LIMIT 5
        `);
        return rows;
      }
      const cleanText = text.trim();
      const match = `%${cleanText}%`;
      const pinyinText = pinyin(cleanText, { toneType: 'none', type: 'array' }).join('');
      const pinyinMatch = `%${pinyinText}%`;
      
      const rows = await this.db.getAllAsync(`
        SELECT DISTINCT locationCity AS name, 'city' AS type FROM MediaAsset WHERE (locationCity LIKE ? OR locationPinyin LIKE ? OR locationCity LIKE ? OR locationPinyin LIKE ?) AND locationCity IS NOT NULL
        UNION
        SELECT DISTINCT locationState AS name, 'state' AS type FROM MediaAsset WHERE (locationState LIKE ? OR locationPinyin LIKE ? OR locationState LIKE ? OR locationPinyin LIKE ?) AND locationState IS NOT NULL
        UNION
        SELECT DISTINCT locationCountry AS name, 'country' AS type FROM MediaAsset WHERE (locationCountry LIKE ? OR locationPinyin LIKE ? OR locationCountry LIKE ? OR locationPinyin LIKE ?) AND locationCountry IS NOT NULL
        LIMIT 6
      `, [match, match, pinyinMatch, pinyinMatch, match, match, pinyinMatch, pinyinMatch, match, match, pinyinMatch, pinyinMatch]);
      return rows;
    } catch (e) {
      console.error('[AssetDBService] Failed to get location suggestions:', e);
      return [];
    }
  }

  // Save/merge metadata for an asset
  async saveAssetMetadata(idOrHash, newMetadata) {
    if (!this.db) return;
    try {
      const row = await this.db.getFirstAsync(
        'SELECT metadata FROM MediaAsset WHERE id = ? OR hash = ?',
        [idOrHash, idOrHash]
      );
      let existingMeta = {};
      if (row && row.metadata) {
        try {
          existingMeta = JSON.parse(row.metadata);
        } catch (e) {
          // ignore parsing error for malformed string
        }
      }
      const mergedMeta = { ...existingMeta, ...newMetadata };
      await this.db.runAsync(
        'UPDATE MediaAsset SET metadata = ? WHERE id = ? OR hash = ?',
        [JSON.stringify(mergedMeta), idOrHash, idOrHash]
      );
    } catch (error) {
      console.error('[AssetDBService] Failed to save asset metadata:', error);
    }
  }

  // Bulk delete assets from SQLite database in a single transaction
  async deleteAssets(idsOrHashes) {
    if (!this.db || !idsOrHashes || idsOrHashes.length === 0) return;
    try {
      const chunkSize = 100;
      for (let i = 0; i < idsOrHashes.length; i += chunkSize) {
        const chunk = idsOrHashes.slice(i, i + chunkSize);
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync('DELETE FROM MediaAsset WHERE id = ? OR hash = ?');
          try {
            for (const id of chunk) {
              if (id) statement.executeSync(id, id);
            }
          } finally {
            await statement.finalizeAsync();
          }
        });
        if (i + chunkSize < idsOrHashes.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      console.log(`[AssetDBService] Bulk deleted ${idsOrHashes.length} assets from SQLite.`);
    } catch (error) {
      console.error('[AssetDBService] Failed to bulk delete assets from SQLite:', error);
    }
  }

  async clearFaceData() {
    await this.initPromise;
    try {
      await this.db.execAsync('UPDATE MediaAsset SET faceRecVersion = 0');
      console.log('[AssetDBService] Cleared all local face detection records (faceRecVersion = 0)');
    } catch (error) {
      console.error('[AssetDBService] Failed to clear face data:', error);
      throw error;
    }
  }
}

export default new AssetDBService();
