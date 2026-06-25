import { Platform, AppState, DeviceEventEmitter, Image, PixelRatio } from 'react-native';
import axios from 'axios';
import * as ExpoLomoHasher from '../../modules/expo-lomo-hasher';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import * as MediaLibrary from 'expo-media-library';
import AssetDBService from './AssetDBService';
import AuthService from './AuthService';
import MediaService from './MediaService';
import TaskSchedulerService from './TaskSchedulerService';
import { recognizeText } from '@infinitered/react-native-mlkit-text-recognition';

export const BACKGROUND_AI_SYNC_TASK = 'LOMO_AI_SYNC_TASK';

// Pure JS JPEG EXIF orientation reader.
// Attempts a partial read of the first 64KB of the file to locate the EXIF APP1 marker.
// Returns the EXIF Orientation integer (1╬ô├ç├┤8), or 1 (no rotation) on failure.
async function readJpegExifOrientation(filePath) {
  try {
    const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    let b64;
    try {
      // Try partial read first (supported by expo-file-system legacy on both platforms)
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 65536,
        position: 0,
      });
    } catch (_) {
      // Fallback: read the full file (may be slow for large photos)
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Only process the first 87382 characters (~65KB of binary)
      if (b64.length > 87382) b64 = b64.substring(0, 87382);
    }

    const binary = atob(b64);
    const len = Math.min(binary.length, 65536);
    const view = new Uint8Array(len);
    for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);

    // Check JPEG SOI marker (0xFFD8)
    if (view[0] !== 0xFF || view[1] !== 0xD8) return 1;

    let offset = 2;
    while (offset < len - 4) {
      if (view[offset] !== 0xFF) break;
      const marker = view[offset + 1];
      const segLength = (view[offset + 2] << 8) | view[offset + 3];
      // APP1 marker (0xFFE1) contains EXIF data
      if (marker === 0xE1) {
        // Check for "Exif\0\0" header at offset+4
        if (offset + 10 < len &&
            view[offset + 4] === 0x45 && // E
            view[offset + 5] === 0x78 && // x
            view[offset + 6] === 0x69 && // i
            view[offset + 7] === 0x66 && // f
            view[offset + 8] === 0x00 && // null
            view[offset + 9] === 0x00) { // null
          // TIFF header starts at offset + 10
          const tiffStart = offset + 10;
          if (tiffStart + 8 > len) return 1;
          // Byte order: 0x4949 = little-endian, 0x4D4D = big-endian
          const isLE = view[tiffStart] === 0x49 && view[tiffStart + 1] === 0x49;
          const readU16 = (pos) => isLE
            ? (view[pos] | (view[pos + 1] << 8))
            : ((view[pos] << 8) | view[pos + 1]);
          const readU32 = (pos) => isLE
            ? ((view[pos] | (view[pos + 1] << 8) | (view[pos + 2] << 16) | (view[pos + 3] << 24)) >>> 0)
            : (((view[pos] << 24) | (view[pos + 1] << 16) | (view[pos + 2] << 8) | view[pos + 3]) >>> 0);
          const ifdOffset = tiffStart + readU32(tiffStart + 4);
          if (ifdOffset + 2 > len) return 1;
          const numEntries = readU16(ifdOffset);
          for (let e = 0; e < numEntries; e++) {
            const entryOffset = ifdOffset + 2 + e * 12;
            if (entryOffset + 12 > len) break;
            const tag = readU16(entryOffset);
            if (tag === 0x0112) { // Orientation tag
              const orientation = readU16(entryOffset + 8);
              console.log(`[AIService] EXIF Orientation from file: ${orientation}`);
              return orientation;
            }
          }
        }
        break; // Only one APP1 segment
      }
      if (marker === 0xDA) break; // SOS = image data starts, stop parsing
      offset += 2 + segLength;
    }
  } catch (e) {
    console.warn('[AIService] readJpegExifOrientation failed:', e.message);
  }
  return 1; // Default: no rotation
}

// Helper: Parse PNG and JPEG file headers directly to extract physical dimensions.
// Reads the first 64KB as base64, decodes to binary, and parses structure in JS.
async function readImagePhysicalDimensions(filePath) {
  try {
    const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    let b64;
    try {
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 65536,
        position: 0,
      });
    } catch (_) {
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (b64.length > 87382) b64 = b64.substring(0, 87382);
    }

    const binary = atob(b64);
    const len = Math.min(binary.length, 65536);
    const view = new Uint8Array(len);
    for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);

    // 1. Check PNG signature: 89 50 4E 47
    if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) {
      if (len >= 24) {
        // Width is at offset 16 (4 bytes, big-endian)
        const w = (view[16] << 24) | (view[17] << 16) | (view[18] << 8) | view[19];
        // Height is at offset 20 (4 bytes, big-endian)
        const h = (view[20] << 24) | (view[21] << 16) | (view[22] << 8) | view[23];
        console.log(`[AIService] Parsed PNG physical dimensions: ${w}x${h}`);
        return { w, h };
      }
    }

    // 2. Check JPEG SOI marker: FF D8
    if (view[0] === 0xFF && view[1] === 0xD8) {
      let offset = 2;
      while (offset < len - 8) {
        if (view[offset] !== 0xFF) break;
        const marker = view[offset + 1];
        const segLength = (view[offset + 2] << 8) | view[offset + 3];

        // SOF markers: 0xC0 - 0xCF (excluding 0xC4, 0xC8, 0xCC)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const h = (view[offset + 5] << 8) | view[offset + 6];
          const w = (view[offset + 7] << 8) | view[offset + 8];
          console.log(`[AIService] Parsed JPEG physical dimensions: ${w}x${h}`);
          return { w, h };
        }

        if (marker === 0xDA) break; // SOS = start of scan, stop parsing
        offset += 2 + segLength;
      }
    }
  } catch (e) {
    console.warn('[AIService] readImagePhysicalDimensions failed:', e.message);
  }
  return null;
}

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

  async _getOrientedDimensions(localAssetId, localPath, rawWidth, rawHeight) {
    console.log(`[AIService] _getOrientedDimensions called for localAssetId=${localAssetId}, rawWidth=${rawWidth}, rawHeight=${rawHeight}`);
    let w = rawWidth || 0;
    let h = rawHeight || 0;

    if (Platform.OS === 'android') {
      let filePath = localPath;
      console.log(`[AIService] [Android] Initial filePath: ${filePath}`);

      // 1. Resolve content:// URIs to localUri if possible
      if (filePath && filePath.startsWith('content://')) {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(localAssetId, { shouldDownloadFromNetwork: false });
          if (info?.localUri) {
            filePath = info.localUri;
            console.log(`[AIService] [Android] Resolved content:// to localUri: ${filePath}`);
          }
          if (!w && info?.width) w = info.width;
          if (!h && info?.height) h = info.height;
        } catch (e) {
          console.warn(`[AIService] [Android] MediaLibrary getAssetInfoAsync failed for ${localAssetId}:`, e.message);
        }
      }

      // 2. Measure dimensions using our pure JS physical reader.
      if (filePath) {
        try {
          const physicalSize = await readImagePhysicalDimensions(filePath);
          if (physicalSize && physicalSize.w > 0 && physicalSize.h > 0) {
            let orientedW = physicalSize.w;
            let orientedH = physicalSize.h;
            let exifOrientation = 1;
            try {
              exifOrientation = await readJpegExifOrientation(filePath);
              console.log(`[AIService] [Android] readImagePhysicalDimensions physical parse succeeded: ${physicalSize.w}x${physicalSize.h}, EXIF Orientation: ${exifOrientation}`);
            } catch (exifErr) {
              console.warn(`[AIService] [Android] Failed to read EXIF orientation inside physical block:`, exifErr.message);
            }
            if ([5, 6, 7, 8].includes(exifOrientation)) {
              console.log(`[AIService] [Android] Swapping physical dimensions ${orientedW}x${orientedH} -> ${orientedH}x${orientedW}`);
              [orientedW, orientedH] = [orientedH, orientedW];
            }
            console.log(`[AIService] [Android] Returning oriented physical size: w=${orientedW}, h=${orientedH}`);
            return { w: orientedW, h: orientedH };
          }
        } catch (e) {
          console.warn(`[AIService] [Android] readImagePhysicalDimensions failed for path ${filePath}:`, e.message);
        }
      }

      // Fallback: Measure dimensions using Image.getSize (returns raw dimensions, unscaled)
      if (filePath) {
        try {
          const size = await new Promise((resolve, reject) =>
            Image.getSize(filePath, (ww, hh) => {
              console.log(`[AIService] [Android] Image.getSize fallback raw callback values: ww=${ww}, hh=${hh}`);
              resolve({ w: ww, h: hh });
            }, reject)
          );
          if (size.w > 0 && size.h > 0) {
            let orientedW = size.w;
            let orientedH = size.h;
            let exifOrientation = 1;
            try {
              exifOrientation = await readJpegExifOrientation(filePath);
            } catch (exifErr) {}
            if ([5, 6, 7, 8].includes(exifOrientation)) {
              console.log(`[AIService] [Android] Fallback: Swapping dimensions ${orientedW}x${orientedH} -> ${orientedH}x${orientedW}`);
              [orientedW, orientedH] = [orientedH, orientedW];
            }
            console.log(`[AIService] [Android] Fallback: Returning oriented size: w=${orientedW}, h=${orientedH}`);
            return { w: orientedW, h: orientedH };
          }
        } catch (e) {
          console.warn(`[AIService] [Android] Image.getSize fallback failed for path ${filePath}:`, e.message);
        }
      }

      // 3. Fallback: If Image.getSize failed, fetch EXIF orientation to swap raw dimensions
      console.log(`[AIService] [Android] Falling back to EXIF orientation resolution for ${localAssetId}`);
      let exifOrientation = 1;
      try {
        const info = await MediaLibrary.getAssetInfoAsync(localAssetId, { shouldDownloadFromNetwork: false, includeExif: true });
        exifOrientation = info?.exif?.Orientation ?? info?.exif?.orientation ?? 1;
        if (!w && info?.width) w = info.width;
        if (!h && info?.height) h = info.height;
        console.log(`[AIService] [Android] EXIF resolution succeeded. Raw size: ${w}x${h}, exifOrientation: ${exifOrientation}`);
      } catch (e) {
        console.warn(`[AIService] [Android] MediaLibrary EXIF fallback failed:`, e.message);
      }

      // Read EXIF from file directly if possible and we have a local path
      if (exifOrientation === 1 && filePath && (filePath.startsWith('file://') || filePath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(filePath))) {
        try {
          exifOrientation = await readJpegExifOrientation(filePath);
          console.log(`[AIService] [Android] Read EXIF directly from file ${filePath}. exifOrientation: ${exifOrientation}`);
        } catch (e) {
          console.warn(`[AIService] [Android] readJpegExifOrientation failed:`, e.message);
        }
      }

      // EXIF orientations 5, 6, 7, 8 imply a 90 or 270 degree rotation — swap w and h
      if (w > 0 && h > 0) {
        if ([5, 6, 7, 8].includes(exifOrientation)) {
          console.log(`[AIService] [Android] EXIF Orientation=${exifOrientation}: Swapping raw dimensions ${w}x${h} -> ${h}x${w}`);
          [w, h] = [h, w];
        } else {
          console.log(`[AIService] [Android] EXIF Orientation=${exifOrientation}: Raw dimensions unchanged ${w}x${h}`);
        }
      }
    } else {
      // iOS
      console.log(`[AIService] [iOS] Resolving oriented dimensions for ${localAssetId}`);
      if (!w || !h) {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(localAssetId, { shouldDownloadFromNetwork: false });
          w = info?.width || w;
          h = info?.height || h;
        } catch (e) {}
      }
    }
    return { w, h };
  }

  // Helper: get oriented dimensions for a file path (local file or downloaded remote file).
  // Uses the pure JS EXIF reader to determine orientation, then applies Image.getSize
  // to get raw pixel dimensions, and swaps if EXIF indicates 90°/270° rotation.
  async _getOrientedDimensionsFromFile(filePath) {
    let w = 0;
    let h = 0;
    
    // Try to get physical dimensions directly from PNG/JPEG headers on Android
    if (Platform.OS === 'android') {
      try {
        const physicalSize = await readImagePhysicalDimensions(filePath);
        if (physicalSize) {
          w = physicalSize.w;
          h = physicalSize.h;
          console.log(`[AIService] _getOrientedDimensionsFromFile physical parse: w=${w}, h=${h}`);
        }
      } catch (e) {
        console.warn(`[AIService] readImagePhysicalDimensions failed in _getOrientedDimensionsFromFile for ${filePath}:`, e.message);
      }
    }

    if (w === 0 || h === 0) {
      try {
        const size = await new Promise((resolve, reject) =>
          Image.getSize(filePath, (ww, hh) => resolve({ w: ww, h: hh }), reject)
        );
        w = size.w;
        h = size.h;
        console.log(`[AIService] _getOrientedDimensionsFromFile Image.getSize fallback: w=${w}, h=${h}`);
      } catch (e) {
        console.warn(`[AIService] Image.getSize failed in _getOrientedDimensionsFromFile for ${filePath}:`, e.message);
      }
    }

    if (Platform.OS === 'android' && w > 0 && h > 0) {
      try {
        const exifOrientation = await readJpegExifOrientation(filePath);
        if ([5, 6, 7, 8].includes(exifOrientation)) {
          console.log(`[AIService] [Android] EXIF Orientation=${exifOrientation} for ${filePath}: Swapping raw dimensions ${w}x${h} -> ${h}x${w}`);
          [w, h] = [h, w];
        }
      } catch (e) {
        console.warn(`[AIService] Failed to read EXIF orientation in _getOrientedDimensionsFromFile:`, e.message);
      }
    }

    return { w, h };
  }

  _processBlocksToMetadata(result, asset) {
    if (!result || !result.blocks || !asset.width || !asset.height) return null;
    console.log(`[AIService] _processBlocksToMetadata: Normalizing coordinates using asset.width=${asset.width}, asset.height=${asset.height}`);
    const blocksList = [];
    for (let i = 0; i < result.blocks.length; i++) {
      const block = result.blocks[i];
      if (block.frame) {
        if (i < 5) {
          console.log(`[AIService] Block ${i}: text="${block.text.replace(/\n/g, ' ')}", frame: left=${block.frame.left}, top=${block.frame.top}, right=${block.frame.right}, bottom=${block.frame.bottom}`);
        }
        const w = (block.frame.right - block.frame.left) / asset.width;
        const h = (block.frame.bottom - block.frame.top) / asset.height;
        const x = block.frame.left / asset.width;
        const y = block.frame.top / asset.height; // top-left origin
        blocksList.push({
           text: block.text,
           frame: { x, y, w, h }
        });
      }
    }
    return blocksList;
  }

  // Extract OCR manually for an asset
  async extractOCRForAsset(asset, returnFullResult = false) {
    console.log(`[AIService] extractOCRForAsset called for asset ${asset.id}, isLocal=${asset.isLocal}`);
    try {
      let result = null;
      let tempUri = null;
      let imgWidth = asset.width;
      let imgHeight = asset.height;

      if (asset.isLocal || asset.status === 'local' || asset.status === 'synced') {
        let localPath = asset.localCachePath || asset.uri;
        console.log(`[AIService] isLocal branch. initial localPath: ${localPath}`);
        
        let rawWidth = asset.width || 0;
        let rawHeight = asset.height || 0;
        try {
          const info = await MediaService.getAssetInfo(asset.id);
          if (info) {
            rawWidth = info.width || rawWidth;
            rawHeight = info.height || rawHeight;
            if (!localPath) {
              localPath = info.localUri || info.uri;
            }
          }
        } catch (e) {
          console.warn(`[AIService] Failed to get local asset info for OCR dimensions:`, e.message);
        }

        if (!localPath && Platform.OS === 'android') {
           localPath = `content://media/external/images/media/${asset.id}`;
        } else if (!localPath && Platform.OS === 'ios') {
           localPath = `ph://${asset.id}`;
        }

        // Get EXIF-corrected oriented dimensions (MLKit processes in oriented space)
        const oriented = await this._getOrientedDimensions(asset.id, localPath, rawWidth, rawHeight);
        imgWidth = oriented.w;
        imgHeight = oriented.h;
        console.log(`[AIService] Oriented image dimensions for OCR normalization: ${imgWidth}x${imgHeight}`);

        if (localPath) {
          console.log(`[AIService] Calling recognizeText with localPath: ${localPath}`);
          result = await recognizeText(localPath);
        }
      } else {
        const url = AuthService.getServerUrl();
        const token = AuthService.getToken();
        const originalUrl = `${url}/asset/${asset.hash}?token=${token}`;
        tempUri = `${FileSystem.cacheDirectory}ocr_manual_${asset.hash}.jpg`;
        console.log(`[AIService] remote branch. downloading ${originalUrl} to ${tempUri}`);
        const downloadRes = await FileSystem.downloadAsync(originalUrl, tempUri);
        console.log(`[AIService] download finished with status: ${downloadRes.status}`);
        if (downloadRes.status === 200) {
          console.log(`[AIService] Calling recognizeText on downloaded file...`);
          result = await recognizeText(downloadRes.uri);
          
          // For remote files: server typically serves fully-oriented images
          const remoteOriented = await this._getOrientedDimensionsFromFile(downloadRes.uri);
          imgWidth = remoteOriented.w || imgWidth;
          imgHeight = remoteOriented.h || imgHeight;
          console.log(`[AIService] Resolved remote image oriented size: ${imgWidth}x${imgHeight}`);
        }
      }

      console.log(`[AIService] recognizeText returned:`, result ? 'success' : 'null');
      const text = result && result.text ? result.text.trim() : "none";
      await AssetDBService.saveAssetOCR(asset.id, text || "none");
      
      let blocksList = null;
      if (result && result.blocks) {
         const enrichedAsset = { ...asset, width: imgWidth, height: imgHeight };
         blocksList = this._processBlocksToMetadata(result, enrichedAsset);
         if (blocksList) {
            // Save blocks AND the oriented dims used for normalization so the UI can render correctly
            await AssetDBService.saveAssetMetadata(asset.id, {
              "mlkit.vision.text.blocks": JSON.stringify(blocksList),
              "mlkit.vision.text.dims": JSON.stringify({ w: imgWidth, h: imgHeight })
            });
         }
      }

      if (tempUri) {
        await FileSystem.deleteAsync(tempUri, { idempotent: true });
      }

      if (returnFullResult) {
        return { text: text || "none", blocks: blocksList, dims: { w: imgWidth, h: imgHeight } };
      }
      return text || "none";
    } catch (e) {
      console.error(`[AIService] Manual OCR extraction failed for ${asset.id}:`, e);
      throw e;
    }
  }

  async getPrototypeTextVector() {
    if (this.textPrototypeVector) return this.textPrototypeVector;
    try {
      this.textPrototypeVector = await this.getTextEmbedding("screenshot receipt document text menu");
      return this.textPrototypeVector;
    } catch (e) {
      console.warn('[AIService] Failed to generate prototype text vector', e);
      return null;
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
          AND ((clipEmbeddingVersion IS NULL OR clipEmbeddingVersion < 1) OR (phash IS NULL OR phash = "") OR (ocrText IS NULL))
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
          SELECT id, hash, isLocal, clipEmbeddingVersion, phash, ocrText 
          FROM MediaAsset 
          WHERE isLocal = 1 
            AND mediaType = "photo" 
            AND ((clipEmbeddingVersion IS NULL OR clipEmbeddingVersion < 1) OR (phash IS NULL OR phash = "") OR (ocrText IS NULL))
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
            let imgWidth = 0;
            let imgHeight = 0;
            try {
              const info = await MediaService.getAssetInfo(asset.id);
              localPath = info?.localUri || info?.uri;
              imgWidth = info?.width || 0;
              imgHeight = info?.height || 0;
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

            // C. Calculate OCR if missing
            if (asset.ocrText === null) {
              try {
                const result = await recognizeText(localPath);
                const text = result && result.text ? result.text.trim() : "none";
                await AssetDBService.saveAssetOCR(asset.id, text || "none");
                if (result && result.blocks) {
                   // Get EXIF-corrected oriented dimensions for accurate normalization
                   const oriented = await this._getOrientedDimensions(asset.id, localPath, imgWidth, imgHeight);
                   const ocrWidth = oriented.w || imgWidth;
                   const ocrHeight = oriented.h || imgHeight;
                   console.log(`[AIService] Background OCR oriented dims: ${ocrWidth}x${ocrHeight}`);
                   const enrichedAsset = { ...asset, width: ocrWidth, height: ocrHeight };
                   const blocksList = this._processBlocksToMetadata(result, enrichedAsset);
                   if (blocksList) {
                     await AssetDBService.saveAssetMetadata(asset.id, {
                       "mlkit.vision.text.blocks": JSON.stringify(blocksList),
                       "mlkit.vision.text.dims": JSON.stringify({ w: ocrWidth, h: ocrHeight })
                     });
                   }
                }
                if (text && text !== "none") {
                  console.log(`[AIService] Saved OCR text locally for asset ${asset.id}.`);
                }
              } catch (oe) {
                console.warn(`[AIService] Failed to extract OCR for local asset ${asset.id}:`, oe.message);
                await AssetDBService.saveAssetOCR(asset.id, "failed");
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
            if (asset.ocrText === null) {
              await AssetDBService.saveAssetOCR(asset.id, 'failed');
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
              current: processedUploads,
              total: totalUploads,
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
              current: processedPHashUploads,
              total: totalPHashUploads,
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
                current: Math.min(processedDownloads, totalDownloads),
                total: totalDownloads,
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
                let foundOcr = false;
                let ocrVal = 'none';
                
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
                  if (meta.Name === 'ios.vision.text.content') {
                    if (meta.Value && meta.Value.length > 0) {
                      // lomo-ios stores a JSON array of strings
                      try {
                        const parsed = JSON.parse(meta.Value);
                        if (Array.isArray(parsed)) {
                          ocrVal = parsed.join(' ');
                          foundOcr = true;
                        }
                      } catch(e) {
                         // fallback to raw string if not JSON
                         ocrVal = meta.Value;
                         foundOcr = true;
                      }
                    }
                  }
                }
              }

              pHashUpdates.push({ idOrHash: asset.hash, phash: pHashVal });
              embeddingUpdates.push({ idOrHash: asset.hash, embedding: embeddingVal, version: foundEmbedding ? 1 : 1 });
              
              if (foundOcr && ocrVal && ocrVal !== 'none') {
                 await AssetDBService.saveAssetOCR(asset.hash, ocrVal);
              } else if (!foundOcr) {
                 await AssetDBService.saveAssetOCR(asset.hash, 'none');
              }
            } catch (e) {
              if (e.response && e.response.status === 404) {
                pHashUpdates.push({ idOrHash: asset.hash, phash: 'none' });
                embeddingUpdates.push({ idOrHash: asset.hash, embedding: 'none', version: 1 });
                await AssetDBService.saveAssetOCR(asset.hash, 'none');
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
                current: Math.min(processedRemote, totalRemote),
                total: totalRemote,
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

        // Part D: Remote Photo OCR Pre-judgment (idle Wi-Fi/Charging only)
        if (isIdle) {
          const totalRemoteOcrRow = await db.getFirstAsync(`
            SELECT COUNT(*) as count 
            FROM MediaAsset 
            WHERE isLocal = 0 
              AND ocrText IS NULL 
              AND clipEmbedding IS NOT NULL AND clipEmbedding != "none" AND clipEmbedding != "failed"
          `);
          const totalRemoteOcr = totalRemoteOcrRow?.count || 0;
          let processedRemoteOcr = 0;
          let hasMoreRemoteOcr = true;

          const prototypeVector = await this.getPrototypeTextVector();

          while (hasMoreRemoteOcr && prototypeVector) {
            const remotePendingOcr = await db.getAllAsync(`
              SELECT id, hash, isLocal, filename, clipEmbedding 
              FROM MediaAsset 
              WHERE isLocal = 0 
                AND ocrText IS NULL 
                AND clipEmbedding IS NOT NULL AND clipEmbedding != "none" AND clipEmbedding != "failed"
              LIMIT 10
            `);

            if (remotePendingOcr.length === 0) {
              hasMoreRemoteOcr = false;
              break;
            }

            console.log(`[AIService] Part D: Scanning ${remotePendingOcr.length} remote photos for text...`);
            for (const asset of remotePendingOcr) {
              processedRemoteOcr++;
              this.status = {
                isProcessing: true,
                current: Math.min(processedRemoteOcr, totalRemoteOcr),
                total: totalRemoteOcr,
                message: `Pre-judging remote photo text (${Math.min(processedRemoteOcr, totalRemoteOcr)}/${totalRemoteOcr})...`
              };
              DeviceEventEmitter.emit('ai_processing_status', this.status);

              let isSuspectedText = false;
              if (asset.filename && asset.filename.toLowerCase().endsWith('.png')) {
                isSuspectedText = true;
                console.log(`[AIService] Remote asset ${asset.hash} is PNG screenshot, bypassing CLIP pre-judgment.`);
              } else {
                let imageVector = this.vectorCache.get(asset.id);
                if (!imageVector && asset.clipEmbedding) {
                   try { imageVector = base64ToFloat32Array(asset.clipEmbedding); } catch(e) {}
                }
                if (imageVector) {
                  let score = 0;
                  const dims = Math.min(prototypeVector.length, imageVector.length);
                  for (let i = 0; i < dims; i++) score += prototypeVector[i] * imageVector[i];
                  if (score > 0.26) {
                    isSuspectedText = true;
                    console.log(`[AIService] Remote asset ${asset.hash} suspected text (score=${score.toFixed(3)}).`);
                  }
                }
              }

              if (isSuspectedText) {
                 try {
                   console.log(`[AIService] Downloading original for remote asset ${asset.hash} for OCR...`);
                   await this.extractOCRForAsset(asset);
                 } catch(e) {
                   console.warn(`[AIService] Failed to extract OCR for remote asset ${asset.hash}:`, e.message);
                   await AssetDBService.saveAssetOCR(asset.id, 'failed');
                 }
              } else {
                 console.log(`[AIService] Skip OCR for remote photo ${asset.hash}.`);
                 await AssetDBService.saveAssetOCR(asset.id, 'none');
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
        // e.g. "20251231_67311.mp4" or "67311.jpg"
        const basename = row.filename.split('.')[0];
        // Split by '_' to handle Date_ID formats
        const nameParts = basename.split('_');
        
        // Try the last part first (often the ID in Date_ID format)
        let idVal = parseInt(nameParts[nameParts.length - 1], 10);
        
        // If the last part wasn't a number, try the first part (legacy ID.filename format)
        if (isNaN(idVal) && nameParts.length > 1) {
            idVal = parseInt(nameParts[0], 10);
        }

        if (!isNaN(idVal) && idVal > 0) {
          // Additional safety check: If it looks like a YYYYMMDD date (e.g. 20251231)
          // and we have a network fallback, we might still want to verify.
          // But usually the ID is the last part now, so it shouldn't hit the date.
          return idVal;
        }
      }

      // Fallback: If parsing the filename fails, fetch the ID directly from the server using the hash
      const url = AuthService.getServerUrl();
      const token = AuthService.getToken();
      if (url && token) {
        try {
          const res = await axios.get(`${url}/asset/metadata/${hash}`, {
            headers: { Authorization: `token=${token}` },
            timeout: 10000,
            skipAutoProbe: true
          });
          const data = res.data;
          if (data) {
            if (data.Id !== undefined) return parseInt(data.Id, 10);
            if (data.ID !== undefined) return parseInt(data.ID, 10);
            if (data.id !== undefined) return parseInt(data.id, 10);
          }
        } catch (fetchErr) {
          console.warn(`[AIService] Fallback failed to fetch server asset ID for hash ${hash}:`, fetchErr.message);
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

      // Fetch OCR exact matches if it's a text search
      const ocrMatchedHashes = new Set();
      const ocrCandidates = [];
      if (!isImageSearch && queryTextOrVector.trim().length > 0) {
        try {
          const ocrRows = await db.getAllAsync(`
            SELECT id, hash, filename, mediaType, createTime AS creationTime, isLocal, localCachePath, isFavorite
            FROM MediaAsset
            WHERE ocrText LIKE ? AND ocrText != "none" AND ocrText != "failed"
          `, [`%${queryTextOrVector}%`]);
          
          for (const row of ocrRows) {
            ocrMatchedHashes.add(row.hash || row.id.toString());
            ocrCandidates.push({
              id: row.id,
              hash: row.hash,
              filename: row.filename,
              mediaType: row.mediaType || 'photo',
              creationTime: row.creationTime || 0,
              isLocal: row.isLocal === 1,
              localCachePath: row.localCachePath,
              isFavorite: row.isFavorite === 1,
              score: 1.0, // Force OCR matches to the top
              isOcrMatch: true
            });
          }
          if (ocrCandidates.length > 0) {
             console.log(`[AIService] Found ${ocrCandidates.length} exact OCR matches for "${queryTextOrVector}".`);
          }
        } catch (e) {
          console.warn('[AIService] OCR search query failed:', e);
        }
      }

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
        // Merge OCR candidates
        results = [...ocrCandidates, ...results];
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

  // Reset and force recalculate all OCR text and blocks cache
  async forceRebuildOCR() {
    const db = AssetDBService.db;
    if (!db) return;
    try {
      console.log('[AIService] Resetting all OCR text and blocks cache in DB...');
      
      // Run the DB updates in the background without awaiting them, so the UI is released instantly
      Promise.all([
        db.runAsync('UPDATE MediaAsset SET ocrText = NULL WHERE ocrText IS NOT NULL')
      ]).then(async () => {
        console.log('[AIService] ocrText cleared in DB. Cleaning metadata columns...');
        try {
          // Fetch all assets with non-empty metadata
          const rows = await db.getAllAsync('SELECT id, metadata FROM MediaAsset WHERE metadata IS NOT NULL AND metadata != ""');
          let updatedCount = 0;
          await db.withExclusiveTransactionAsync(async () => {
            const statement = await db.prepareAsync('UPDATE MediaAsset SET metadata = ? WHERE id = ?');
            try {
              for (const row of rows) {
                if (row.metadata) {
                  try {
                    const meta = JSON.parse(row.metadata);
                    let changed = false;
                    if ('mlkit.vision.text.blocks' in meta) {
                      delete meta['mlkit.vision.text.blocks'];
                      changed = true;
                    }
                    if ('ios.vision.text.bounding' in meta) {
                      delete meta['ios.vision.text.bounding'];
                      changed = true;
                    }
                    if ('ios.vision.text.content' in meta) {
                      delete meta['ios.vision.text.content'];
                      changed = true;
                    }
                    if (changed) {
                      statement.executeSync(JSON.stringify(meta), row.id);
                      updatedCount++;
                    }
                  } catch (e) {}
                }
              }
            } finally {
              await statement.finalizeAsync();
            }
          });
          console.log(`[AIService] Successfully cleaned metadata for ${updatedCount} assets.`);
        } catch (err) {
          console.error('[AIService] Failed to clean metadata OCR blocks:', err.message);
        }
        
        // Trigger extraction and sync immediately in the background asynchronously
        this.processLocalEmbeddings(50, true).then(() => {
          this.syncEmbeddings(true).catch(e => console.warn('[AIService] Background syncEmbeddings for OCR failed:', e.message));
        }).catch(e => {
          console.error('[AIService] Background processLocalEmbeddings for OCR failed:', e);
        });
      }).catch(e => {
        console.error('[AIService] Failed to reset ocrText in DB:', e);
      });
    } catch (e) {
      console.error('[AIService] Failed to rebuild OCR cache:', e);
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
