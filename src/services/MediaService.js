import * as MediaLibrary from 'expo-media-library';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { hashFileAsync, isLivePhotoAsync, prepareLivePhotoBackupAsync, extractVideoFromZipAsync, getLocalLivePhotoVideoUriAsync } from '../../modules/expo-lomo-hasher';
import axios from 'axios';
import AuthService from './AuthService';

class MediaService {
  /**
   * Generates a preview URL strictly adhering to the lomorage backend's pre-generated dimensions 
   * to avoid expensive server-side dynamic transcoding.
   */
  getPreviewUrl(hash, mediaType, isLarge = false) {
    if (!hash) return null;
    let width = 320; // Default small image preview
    if (mediaType === 'video') {
      width = 480; // Default video preview
    } else if (isLarge) {
      width = 640; // Max image preview
    }
    const token = AuthService.getToken();
    return `${AuthService.getServerUrl()}/preview/${hash}?width=${width}&height=-1&token=${token}`;
  }


  async requestPermissions() {
    console.log('Checking permissions for', Platform.OS, Platform.Version);
    const existing = await MediaLibrary.getPermissionsAsync();
    console.log('Existing permission status:', existing.status, 'granted:', existing.granted);

    // On Android, we need to check if we also have the required granular permissions
    if (existing.granted) {
      if (Platform.OS !== 'android') {
        return true;
      }
      
      const { PermissionsAndroid } = require('react-native');
      let needsRequest = false;
      
      if (Platform.Version >= 33) {
        const hasImages = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES);
        const hasLocation = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION);
        if (!hasImages || !hasLocation) needsRequest = true;
      } else if (Platform.Version >= 29) {
        const hasLocation = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION);
        if (!hasLocation) needsRequest = true;
      }
      
      if (!needsRequest) {
        return true; // We already have everything, don't trigger a system dialog!
      }
    }

    try {
      console.log('Requesting permissions...', Platform.OS, Platform.Version);
      const { status } = await MediaLibrary.requestPermissionsAsync();
      console.log('Permission request result:', status);

      // On Android 13+ (API 33), we need READ_MEDIA_IMAGES/VIDEO
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        const { PermissionsAndroid } = require('react-native');
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
          PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        ]);
      } else if (Platform.OS === 'android' && Platform.Version >= 29) {
        const { PermissionsAndroid } = require('react-native');
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        ]);
      }

      return status === 'granted';
    } catch (error) {
      console.error('Permission request failed:', error);
      const final = await MediaLibrary.getPermissionsAsync();
      if (Platform.OS === 'android') {
        const { PermissionsAndroid } = require('react-native');
        const hasLocation = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION
        );
        console.log('Final location permission check:', hasLocation);
      }
      return final.granted;
    }
  }

  normalizeUri(uri) {
    if (!uri) return uri;
    let normalized = uri;
    // iOS Photos framework URIs must be passed as-is
    if (normalized.startsWith('ph://') || normalized.startsWith('asset-library://')) {
      return normalized;
    }
    if (!normalized.startsWith('file://') && !normalized.startsWith('content://')) {
      if (normalized.startsWith('//')) {
        normalized = `file:${normalized}`;
      } else if (normalized.startsWith('/')) {
        normalized = `file://${normalized}`;
      }
    }
    // Escape '#' which is interpreted as a URL fragment by native file system APIs
    if (normalized.startsWith('file://') && normalized.includes('#')) {
      normalized = normalized.replace(/#/g, '%23');
    }
    return normalized;
  }

  async getAssets(first = 50, after = null) {
    console.log('Fetching assets...', { first, after });
    const options = {
      first,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    };
    if (after) {
      options.after = after;
    }

    const result = await MediaLibrary.getAssetsAsync(options);
    console.log(`Fetched ${result?.assets?.length} assets. hasNextPage: ${result?.hasNextPage}`);
    return result;
  }

  /**
   * Helper function to fetch all asset IDs belonging to excluded albums.
   * This is necessary because iOS assets don't reliably expose 'albumId' in the global list.
   */
  async getExcludedAssetIds(excludedAlbumIds) {
    const excludedIds = new Set();
    if (!excludedAlbumIds || excludedAlbumIds.length === 0) return excludedIds;

    for (const albumId of excludedAlbumIds) {
      try {
        let hasNextPage = true;
        let after = null;
        while (hasNextPage) {
          const result = await MediaLibrary.getAssetsAsync({
            album: albumId,
            first: 1000,
            after: after
          });
          if (result && result.assets) {
            for (const asset of result.assets) {
              excludedIds.add(asset.id);
            }
          }
          after = result.endCursor;
          hasNextPage = result.hasNextPage && result.assets && result.assets.length > 0;
        }
      } catch (e) {
        console.warn(`[MediaService] Failed to fetch assets for excluded album ${albumId}:`, e.message);
      }
    }
    console.log(`[MediaService] Found ${excludedIds.size} total excluded assets from ${excludedAlbumIds.length} albums.`);
    return excludedIds;
  }

  /**
   * P0 Fix: Fetch ALL assets from the library via pagination.
   * Replaces the previous hardcoded getAssets(5000) which silently dropped photos beyond 5000.
   * Calls onPage(assets, pageNum) for each page so callers can process incrementally.
   */
  async getAllAssets(onPage = null, pageSize = 500, excludedAlbumIds = []) {
    let allAssets = [];
    let after = null;
    let hasNextPage = true;
    let pageNum = 0;

    // Fetch the Set of excluded asset IDs upfront
    const excludedSet = await this.getExcludedAssetIds(excludedAlbumIds);

    while (hasNextPage) {
      pageNum++;
      const result = await this.getAssets(pageSize, after);
      let assets = result.assets || [];

      // Filter out assets that belong to excluded albums
      if (excludedSet.size > 0) {
        const originalCount = assets.length;
        assets = assets.filter(a => !excludedSet.has(a.id));
        if (assets.length < originalCount) {
          console.log(`[MediaService] Filtered out ${originalCount - assets.length} excluded assets on page ${pageNum}`);
        }
      }

      allAssets = allAssets.concat(assets);

      if (onPage) {
        await onPage(assets, pageNum);
      }

      after = result.endCursor;
      hasNextPage = result.hasNextPage && assets.length > 0;

      console.log(`[MediaService] getAllAssets page ${pageNum}: ${assets.length} assets (total: ${allAssets.length}, hasNextPage: ${hasNextPage})`);
    }

    return allAssets;
  }

  async getAssetInfo(assetId, options = { shouldDownloadFromNetwork: false }) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(assetId, options);
      if (info) {
        if (info.uri) info.uri = this.normalizeUri(info.uri);
        if (info.localUri) info.localUri = this.normalizeUri(info.localUri);
      }
      return info;
    } catch (e) {
      console.error(`Failed to get info for asset ${assetId}`, e);
      return null;
    }
  }

  // Get file size in bytes for a local asset using Expo FileSystem
  async getAssetSize(assetId) {
    try {
      const info = await this.getAssetInfo(assetId);
      if (!info) return 0;
      const uri = info.localUri || info.uri;
      if (!uri) return 0;
      const fileInfo = await LegacyFileSystem.getInfoAsync(uri, { size: true });
      return fileInfo.exists ? (fileInfo.size || 0) : 0;
    } catch (e) {
      console.error(`[MediaService] Failed to get size for ${assetId}:`, e);
      return 0;
    }
  }

  /**
   * Calculate SHA-1 hash of a file.
   * 
   * Strategy (mirrors lomo-android's LomoUtils.toSHA1EX):
   *  - Use expo-file-system/legacy readAsStringAsync with base64 encoding + position/length
   *    for chunked streaming. This uses native file I/O the same way Android's FileInputStream does,
   *    avoiding the ExpoFile.open() sandbox restriction.
   *  - For small files (<= 50MB), use file.bytes() + Crypto.digest as a simpler path.
   * 
   * Returns lowercase hex SHA-1 string, or null on failure.
   */
  async calculateHash(fileUri, silent = false) {
    try {
      if (!fileUri) return null;

      // Normalize URI
      const normalizedUri = this.normalizeUri(fileUri);

      if (!silent) console.log(`[MediaService] Hashing: ${normalizedUri}`);

      let fileSize = 0;
      if (!normalizedUri.startsWith('content://')) {
        // Use encoded URI for Expo FileSystem to prevent fragment truncation
        const fileInfo = await LegacyFileSystem.getInfoAsync(normalizedUri, { size: true });
        if (!fileInfo.exists) {
          if (!silent) console.log(`[MediaService] File does not exist: ${normalizedUri}`);
          return null;
        }
        fileSize = fileInfo.size || 0;
        if (fileSize === 0) {
          if (!silent) console.log(`[MediaService] File size is 0: ${normalizedUri}`);
          return null;
        }
      }

      // NATIVE HASHER: Pass the RAW path string. 
      // Native File APIs (Java/Kotlin) expect literal characters, not URL encoding.
      let digest = null;
      let usedNative = false;

      try {
        const rawPath = fileUri.replace('file://', '');
        if (!silent) console.log(`[MediaService] Native hasher call on raw path: ${rawPath}`);
        const startTime = Date.now();
        digest = await hashFileAsync(rawPath);
        const duration = Date.now() - startTime;
        
        if (digest) {
           usedNative = true;
           digest = digest.toLowerCase();
           if (!silent) console.log(`[MediaService] NATIVE Hash complete: ${digest} (${duration}ms)`);
           return digest;
        }
      } catch (nativeError) {
        if (!silent) console.warn(`[MediaService] Native hasher error on raw path:`, nativeError.message);
      }

      if (!usedNative) {
        // --- FALLBACK PURE JS CHUNKING (SLOW) ---
        // Use chunked base64 streaming via legacy readAsStringAsync.
        const sha1 = require('js-sha1');
        const hasher = sha1.create();
        const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
        let position = 0;
        const startTime = Date.now();

        if (!silent) console.log(`[MediaService] Native hasher unavailable. Using SLOW JS streaming for ${fileSize} bytes in ${Math.ceil(fileSize / CHUNK_SIZE)} chunks...`);

        while (position < fileSize) {
          const length = Math.min(CHUNK_SIZE, fileSize - position);
          const base64Chunk = await LegacyFileSystem.readAsStringAsync(normalizedUri, {
            encoding: LegacyFileSystem.EncodingType.Base64,
            position,
            length,
          });

          // Decode base64 to byte array and feed to hasher
          const binary = global.atob(base64Chunk);
          const uint8 = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            uint8[i] = binary.charCodeAt(i);
          }
          hasher.update(uint8);
          position += length;

          // Yield to prevent UI thread blocking
          if (position % (5 * CHUNK_SIZE) === 0 || position >= fileSize) {
             await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        digest = hasher.hex();
        const duration = Date.now() - startTime;
        if (!silent) console.log(`[MediaService] JS Hash complete in ${duration}ms (${fileSize} bytes): ${digest.substring(0, 8)}...`);
      }

      return digest;

    } catch (error) {
      console.error(`[MediaService] calculateHash failed for ${fileUri}:`, error.message);
      return null;
    }
  }

  async deleteRemoteAsset(id, isHash = false) {
    try {
      const serverUrl = AuthService.getServerUrl();
      const token = AuthService.getToken();
      
      const payload = {
        List: [{
           ID: id,
           Type: isHash ? 1 : 0
        }]
      };

      console.log(`[MediaService] Deleting remote asset: ${id} (isHash=${isHash})`);
      
      const response = await axios.delete(`${serverUrl}/asset`, {
        headers: { Authorization: `token=${token}` },
        data: payload
      });

      return response.status === 200;
    } catch (error) {
      console.error('[MediaService] Error deleting remote asset:', error.message);
      throw error;
    }
  }

  async deleteLocalAsset(localId) {
    try {
      const realId = localId.startsWith('local-') ? localId.replace('local-', '') : localId;
      console.log(`[MediaService] Deleting local asset natively: ${realId}`);
      await MediaLibrary.deleteAssetsAsync([realId]);
      return true;
    } catch (error) {
      console.error('[MediaService] Error deleting local asset:', error.message);
      if (error.message && error.message.includes("didn't grant write permission")) {
         throw new Error("System deletion was cancelled. Android requires you to explicitly tap 'Allow' or 'Move to Trash' in the popup to delete photos from the device.");
      }
      throw error;
    }
  }

  async isLivePhotoAsync(uri) {
    if (Platform.OS !== 'ios' || !uri) return false;
    try {
      return await isLivePhotoAsync(uri);
    } catch (e) {
      console.warn('[MediaService] isLivePhotoAsync check failed:', e.message);
      return false;
    }
  }

  async prepareLivePhotoBackupAsync(uri) {
    if (Platform.OS !== 'ios' || !uri) return null;
    try {
      return await prepareLivePhotoBackupAsync(uri);
    } catch (e) {
      console.error('[MediaService] prepareLivePhotoBackupAsync failed:', e.message);
      throw e;
    }
  }

  async getLocalLivePhotoVideoUriAsync(uri) {
    if (Platform.OS !== 'ios' || !uri) return null;
    try {
      return await getLocalLivePhotoVideoUriAsync(uri);
    } catch (e) {
      console.error('[MediaService] getLocalLivePhotoVideoUriAsync failed:', e.message);
      throw e;
    }
  }

  async extractVideoFromZipAsync(zipUri) {
    if (Platform.OS !== 'ios' || !zipUri) return null;
    try {
      return await extractVideoFromZipAsync(zipUri);
    } catch (e) {
      console.error('[MediaService] extractVideoFromZipAsync failed:', e.message);
      throw e;
    }
  }

  async deleteLocalAssets(localIds) {
    try {
      const realIds = localIds.map(id => id.startsWith('local-') ? id.replace('local-', '') : id);
      console.log(`[MediaService] Deleting local assets natively in bulk:`, realIds);
      await MediaLibrary.deleteAssetsAsync(realIds);
      return true;
    } catch (error) {
      console.error('[MediaService] Error deleting local assets:', error.message);
      if (error.message && error.message.includes("didn't grant write permission")) {
         throw new Error("System deletion was cancelled. Deletion requires you to explicitly tap 'Allow' in the popup.");
      }
      throw error;
    }
  }

  async deleteRemoteAssets(items) {
    try {
      const serverUrl = AuthService.getServerUrl();
      const token = AuthService.getToken();
      
      const payload = {
        List: items.map(item => ({
          ID: item.idOrHash,
          Type: item.isHash ? 1 : 0
        }))
      };

      console.log(`[MediaService] Deleting ${items.length} remote assets in bulk...`);
      
      const response = await axios.delete(`${serverUrl}/asset`, {
        headers: { Authorization: `token=${token}` },
        data: payload
      });

      return response.status === 200;
    } catch (error) {
      console.error('[MediaService] Error deleting remote assets in bulk:', error.message);
      throw error;
    }
  }
}

export default new MediaService();
