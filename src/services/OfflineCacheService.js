import * as FileSystem from 'expo-file-system';
import { DeviceEventEmitter } from 'react-native';
import AssetDBService from './AssetDBService';
import RemoteAlbumService from './RemoteAlbumService';
import AuthService from './AuthService';

const CACHE_DIR = FileSystem.documentDirectory + 'lomo_favorites/';

class OfflineCacheService {
  constructor() {
    this.isSyncing = false;
    this.ensureCacheDirectory();
  }

  async ensureCacheDirectory() {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  }

  /**
   * Syncs the Favorites list from the server to the local SQLite database.
   */
  async syncFavoritesFromServer() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      console.log('[OfflineCacheService] Syncing favorites from server...');
      const albums = await RemoteAlbumService.getAlbums();
      // Look for the reserved Favorites album, iOS uses "/Favorites", others might use "Favorites"
      let favAlbum = albums.find(a => a.name === '/Favorites' || a.name === 'Favorites');
      
      if (!favAlbum) {
        console.log('[OfflineCacheService] No /Favorites album found on server. Creating it...');
        favAlbum = await RemoteAlbumService.createAlbum('/Favorites');
        if (!favAlbum) {
          console.warn('[OfflineCacheService] Failed to create /Favorites album.');
          this.isSyncing = false;
          return;
        }
      }

      const favoriteHashes = await RemoteAlbumService.getAlbumAssets(favAlbum.id);
      console.log(`[OfflineCacheService] Found ${favoriteHashes.length} favorite assets on server.`);

      if (!AssetDBService.db) {
        this.isSyncing = false;
        return;
      }

      // 1. Reset all existing remote favorites to 0
      await AssetDBService.db.runAsync(`UPDATE MediaAsset SET isFavorite = 0 WHERE isLocal = 0`);

      // 2. Set fetched hashes to 1
      // For large lists, this should ideally be batched, but we can iterate for now
      if (favoriteHashes.length > 0) {
        await AssetDBService.db.withExclusiveTransactionAsync(async () => {
          const stmt = await AssetDBService.db.prepareAsync(`UPDATE MediaAsset SET isFavorite = 1 WHERE id = ?`);
          try {
            for (const hash of favoriteHashes) {
              await stmt.executeAsync([hash.toLowerCase()]);
            }
          } finally {
            await stmt.finalizeAsync();
          }
        });
      }

      console.log('[OfflineCacheService] SQLite favorites synced. Triggering cleanup and download.');
      
      // 3. Clean up un-favorited cached files
      await this.cleanupRemovedFavorites();
      
      // 4. Download new favorites
      await this.downloadPendingFavorites();
      
      DeviceEventEmitter.emit('remoteAssetsUpdated');

    } catch (error) {
      console.error('[OfflineCacheService] Failed to sync favorites:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Deletes cached files for assets that are no longer marked as favorites.
   */
  async cleanupRemovedFavorites() {
    if (!AssetDBService.db) return;
    try {
      // Find assets that have a localCachePath but are no longer favorites
      const rows = await AssetDBService.db.getAllAsync(
        `SELECT id, localCachePath FROM MediaAsset WHERE isFavorite = 0 AND localCachePath IS NOT NULL`
      );

      for (const row of rows) {
        try {
          const info = await FileSystem.getInfoAsync(row.localCachePath);
          if (info.exists) {
            await FileSystem.deleteAsync(row.localCachePath, { idempotent: true });
          }
          await AssetDBService.updateAssetCachePath(row.id, null);
          console.log(`[OfflineCacheService] Cleaned up cached file for unfavorited asset: ${row.id}`);
        } catch (e) {
          console.error(`[OfflineCacheService] Error cleaning up ${row.localCachePath}:`, e);
        }
      }
    } catch (error) {
      console.error('[OfflineCacheService] Failed to cleanup removed favorites:', error);
    }
  }

  /**
   * Downloads high-res thumbnails for favorite assets that aren't cached yet.
   */
  async downloadPendingFavorites() {
    const assetsToCache = await AssetDBService.getFavoriteAssetsToCache();
    if (assetsToCache.length === 0) {
      console.log('[OfflineCacheService] No pending favorites to download.');
      return;
    }

    console.log(`[OfflineCacheService] Downloading ${assetsToCache.length} pending favorites...`);
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();

    if (!serverUrl || !token) {
      console.warn('[OfflineCacheService] Cannot download, missing server URL or token.');
      return;
    }

    for (const asset of assetsToCache) {
      // Only cache images for now (or high-res thumbnails of videos)
      const ext = asset.mediaType === 'video' ? 'mp4' : 'jpg';
      const fileUri = `${CACHE_DIR}${asset.hash}.${ext}`;
      
      // For images, we pull a 1200px width preview. For videos, maybe a preview frame or just the video if small?
      // Since video caching can be huge, we'll just cache the high-res image preview for videos too, so it looks good offline.
      const remoteUri = `${serverUrl}/preview/${asset.hash}?width=1200&height=-1&token=${token}`;

      try {
        const downloadRes = await FileSystem.downloadAsync(remoteUri, fileUri);
        if (downloadRes.status === 200) {
          await AssetDBService.updateAssetCachePath(asset.hash, downloadRes.uri);
          console.log(`[OfflineCacheService] Cached ${asset.hash} at ${downloadRes.uri}`);
        } else {
          console.error(`[OfflineCacheService] Failed to download ${asset.hash}, status: ${downloadRes.status}`);
        }
      } catch (error) {
        console.error(`[OfflineCacheService] Exception downloading ${asset.hash}:`, error);
      }
    }
    console.log('[OfflineCacheService] Pending favorites download complete.');
  }

  /**
   * Manually adds a favorite locally and triggers server update/download.
   * Useful when user clicks "Heart" in UI.
   */
  async toggleFavorite(assetHash, isFavorite) {
    // 1. Update SQLite optimistically
    await AssetDBService.setAssetFavoriteStatus(assetHash, isFavorite);
    DeviceEventEmitter.emit('remoteAssetsUpdated');
    
    // 2. Update Server
    try {
      const albums = await RemoteAlbumService.getAlbums();
      let favAlbum = albums.find(a => a.name === '/Favorites' || a.name === 'Favorites');
      if (!favAlbum) {
        favAlbum = await RemoteAlbumService.createAlbum('/Favorites');
      }
      if (favAlbum) {
        if (isFavorite) {
          await RemoteAlbumService.addAssetToAlbum(favAlbum.id, assetHash);
          // Download immediately
          this.downloadPendingFavorites();
        } else {
          await RemoteAlbumService.removeAssetFromAlbum(favAlbum.id, assetHash);
          // Cleanup immediately
          this.cleanupRemovedFavorites();
        }
      }
    } catch (e) {
      console.error('[OfflineCacheService] Failed to toggle favorite on server:', e);
    }
  }
}

export default new OfflineCacheService();
