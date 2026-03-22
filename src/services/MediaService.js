import * as MediaLibrary from 'expo-media-library';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { hashFileAsync } from '../../modules/expo-lomo-hasher';
import axios from 'axios';
import AuthService from './AuthService';

class MediaService {
  async requestPermissions() {
    console.log('Checking permissions for', Platform.OS, Platform.Version);
    const existing = await MediaLibrary.getPermissionsAsync();
    console.log('Existing permission status:', existing.status, 'granted:', existing.granted);

    // Even if granted, we might need to check for location permission on Android
    if (existing.granted && Platform.OS !== 'android') {
      return true;
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

  async getAssetInfo(assetId) {
    try {
      return await MediaLibrary.getAssetInfoAsync(assetId);
    } catch (e) {
      console.error(`Failed to get info for asset ${assetId}`, e);
      return null;
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
      let normalizedUri = fileUri;
      if (!normalizedUri.startsWith('file://') && !normalizedUri.startsWith('content://')) {
        if (normalizedUri.startsWith('//')) {
          normalizedUri = `file:${normalizedUri}`;
        } else if (normalizedUri.startsWith('/')) {
          normalizedUri = `file://${normalizedUri}`;
        }
      }

      if (!silent) console.log(`[MediaService] Hashing: ${normalizedUri}`);

      let fileSize = 0;
      if (!normalizedUri.startsWith('content://')) {
        // Check file info (size) via legacy API — only works for file:// URIs
        const fileInfo = await LegacyFileSystem.getInfoAsync(normalizedUri, { size: true });
        if (!fileInfo.exists) {
          if (!silent) console.log(`[MediaService] File does not exist: ${normalizedUri}`);
          return null;
        }
        fileSize = fileInfo.size || 0;
        if (fileSize === 0) {
          if (!silent) console.log(`[MediaService] File size is 0, skipping: ${normalizedUri}`);
          return null;
        }
      }

      // If in standard Expo Go (not custom dev client), Native Modules don't work reliably.
      // We will try the native hasher first. If it is undefined or fails, fallback to JS.
      let digest = null;
      let usedNative = false;

      try {
        if (!silent) console.log(`[MediaService] Attempting native file hash for ${fileSize} bytes...`);
        const startTime = Date.now();
        digest = await hashFileAsync(normalizedUri);
        const duration = Date.now() - startTime;
        
        if (digest) {
           usedNative = true;
           digest = digest.toLowerCase(); // Consistent matching
           if (!silent) console.log(`[MediaService] NATIVE Hash complete: ${digest} (duration: ${duration}ms, bytes: ${fileSize})`);
           return digest;
        }
      } catch (nativeError) {
        if (!silent) console.warn(`[MediaService] Native hasher failed, falling back to JS chunking. Error:`, nativeError.message);
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
          const binary = atob(base64Chunk);
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
      throw error;
    }
  }
}

export default new MediaService();
