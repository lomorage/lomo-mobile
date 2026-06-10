import * as SQLite from 'expo-sqlite';
import MetricsTracker from '../utils/MetricsTracker';

class AssetDBService {
  constructor() {
    this.dbName = 'lomoAssets.db';
    this.db = null;
  }

  async init() {
    if (this.db) return;
    
    try {
      this.db = await SQLite.openDatabaseAsync(this.dbName);
      // Create the MediaAsset table
      // isLocal: 1 for local, 0 for remote
      // hasGeo: 1 if we have queried/confirmed its GPS (even if 0,0), 0 if unknown
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
          filename TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_isLocal_hasGeo ON MediaAsset(isLocal, hasGeo);
        CREATE INDEX IF NOT EXISTS idx_hasGeo ON MediaAsset(hasGeo);
      `);

      // Migration for legacy databases: Add filename column if it does not exist
      try {
        await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN filename TEXT;`);
        console.log('[AssetDBService] Migration: Added filename column to MediaAsset.');
      } catch (migrationError) {
        // Safe to ignore if column already exists
      }

      // Migration for legacy databases: Add mediaType column if it does not exist
      try {
        await this.db.execAsync(`ALTER TABLE MediaAsset ADD COLUMN mediaType TEXT;`);
        console.log('[AssetDBService] Migration: Added mediaType column to MediaAsset.');
      } catch (migrationError) {
        // Safe to ignore if column already exists
      }

      console.log('[AssetDBService] Database initialized successfully.');
    } catch (error) {
      console.error('[AssetDBService] Failed to initialize DB:', error);
      throw error;
    }
  }

  // Insert or update local assets.
  // We use REPLACE so we don't duplicate. Local assets come from MediaLibrary.
  async insertLocalAssets(assets) {
    if (!this.db || !assets || assets.length === 0) return;

    return await MetricsTracker.measure('AssetDBService_insertLocalAssets', async () => {
      try {
        // Using a transaction for batch insert
        await this.db.withExclusiveTransactionAsync(async () => {
          const statement = await this.db.prepareAsync(`
            INSERT OR REPLACE INTO MediaAsset 
            (id, isLocal, hasGeo, latitude, longitude, createTime, mediaType) 
            VALUES (?, 1, ?, ?, ?, ?, ?)
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

  // Insert remote assets discovered via SyncService
  async insertRemoteAssets(assets) {
    if (!this.db || !assets || assets.length === 0) return;

    const isVideoExtension = (filename) => {
      if (!filename) return false;
      const ext = filename.split('.').pop().toLowerCase();
      return ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext);
    };

    return await MetricsTracker.measure('AssetDBService_insertRemoteAssets', async () => {
      try {
        // 1. Get all existing IDs in SQLite database to filter out duplicates before inserting
        const existingRows = await this.db.getAllAsync('SELECT id FROM MediaAsset');
        const existingIds = new Set(existingRows.map(r => r.id));

        // 2. Filter out already present assets to avoid expensive no-op statement executions
        const newAssets = assets.filter(asset => !existingIds.has(asset.hash));
        if (newAssets.length === 0) {
          console.log('[AssetDBService] No new remote assets to insert.');
          return;
        }

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
              // remote asset uses hash as ID
              const id = asset.hash;
              // createTime might be string or timestamp, best effort parse
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
      } catch (error) {
        console.error('[AssetDBService] Failed to insert remote assets:', error);
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
        `SELECT hash, filename, createTime, mediaType FROM MediaAsset WHERE isLocal = 0 ORDER BY createTime DESC`
      );
      return rows.map(r => ({
        id: `remote-${r.hash}`,
        hash: r.hash,
        filename: r.filename,
        creationTime: r.createTime || 0,
        mediaType: r.mediaType || 'photo'
      }));
    } catch (error) {
      console.error('[AssetDBService] Failed to get remote assets:', error);
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
}

export default new AssetDBService();
