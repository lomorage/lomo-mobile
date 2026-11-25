// What Lomorage keeps on the phone, and keeping the rebuildable part of it bounded.
//
// Users back up with Lomorage because the phone is out of space, so anything the app stores for
// its own convenience has to stay small and be easy to give back. Before this there was no limit
// on any of it and no way to see or clear it: Live Photo videos extracted for playback and the
// originals the Duplicates screen downloads stayed in the cache for good, and favorites kept full
// originals (videos included) in Documents, which iOS never clears.
//
// Managed here, oldest first beyond the user's limit (default DEFAULT_CACHE_LIMIT_MB):
//   - VIEW_CACHE_DIR: originals downloaded to look at one photo (Duplicates screen).
//   - <cache>/<key>.mov: the video of a Live Photo, extracted by the native module for playback.
// Deleted once old enough, whatever the limit (leftovers of work that was cut short):
//   - <cache>/*.raw and *.zip: an upload's exact-bytes copy (UploadService) left by a crash.
//   - one-off temp files of the AI and album screens.
// Not touched: the database, the AI models, favorites' offline copies (each has its own owner),
// files being uploaded right now, and share copies (shareFile.js cleans those up itself).
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

export const VIEW_CACHE_DIR = `${FileSystem.cacheDirectory}lomo_view/`;
export const CACHE_LIMIT_KEY = 'lomo_cache_limit_mb';
export const DEFAULT_CACHE_LIMIT_MB = 500;
// 0 means no limit.
export const CACHE_LIMIT_CHOICES_MB = [250, 500, 1000, 0];

// Leftover temp files are only removed once this old, so nothing in use is deleted under it.
// An upload's .raw copy can live as long as a slow upload of a large video takes.
const STALE_UPLOAD_COPY_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_MS = 60 * 60 * 1000;
// Pruning on every foregrounding would stat the cache over and over for nothing.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const LIVE_VIDEO = /\.mov$/i;
const UPLOAD_COPY = /\.(raw|zip)$/i;
// <sha1>.jpg: AI preview temps. A bare <sha1>: originals the Duplicates screen used to keep here.
const ONE_OFF_TEMP = /^(similar_temp_|set_cover_|ocr_manual_|temp_face_cover_)|^[0-9a-f]{40}(\.jpg)?$/i;

const MB = 1024 * 1024;

async function listFiles(dir) {
  const names = await FileSystem.readDirectoryAsync(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    const uri = `${dir}${name}`;
    const info = await FileSystem.getInfoAsync(uri, { size: true }).catch(() => null);
    if (!info?.exists || info.isDirectory) continue;
    // modificationTime is in seconds.
    files.push({ name, uri, size: info.size || 0, mtimeMs: (info.modificationTime || 0) * 1000 });
  }
  return files;
}

async function sizeOf(uri) {
  const info = await FileSystem.getInfoAsync(uri, { size: true }).catch(() => null);
  return info?.exists ? (info.size || 0) : 0;
}

/**
 * Which files to delete so the managed ones fit in limitBytes: oldest first. limitBytes 0 means
 * no limit. Pure, so the choice can be tested without a file system.
 */
export function pickEvictions(files, limitBytes) {
  if (!limitBytes) return [];
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= limitBytes) return [];
  const evict = [];
  for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= limitBytes) break;
    evict.push(f);
    total -= f.size;
  }
  return evict;
}

/** Leftover temp files in the cache root that are old enough to be safely deleted. */
export function pickStaleTemps(files, now) {
  return files.filter((f) => {
    const age = now - f.mtimeMs;
    if (UPLOAD_COPY.test(f.name)) return age >= STALE_UPLOAD_COPY_MS;
    if (ONE_OFF_TEMP.test(f.name)) return age >= STALE_TEMP_MS;
    return false;
  });
}

class StorageService {
  constructor() {
    this._lastPruneAt = 0;
    this._pruning = null;
  }

  async getCacheLimitMb() {
    const saved = await SecureStore.getItemAsync(CACHE_LIMIT_KEY).catch(() => null);
    const value = saved === null || saved === undefined ? NaN : parseInt(saved, 10);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_LIMIT_MB;
  }

  async setCacheLimitMb(mb) {
    await SecureStore.setItemAsync(CACHE_LIMIT_KEY, String(mb));
    return this.prune({ force: true });
  }

  /** The directory for originals downloaded to look at; created on demand. */
  async viewCacheDir() {
    await FileSystem.makeDirectoryAsync(VIEW_CACHE_DIR, { intermediates: true }).catch(() => {});
    return VIEW_CACHE_DIR;
  }

  async _managedFiles() {
    const root = FileSystem.cacheDirectory;
    const rootFiles = root ? await listFiles(root) : [];
    const viewFiles = await listFiles(VIEW_CACHE_DIR);
    return {
      rootFiles,
      managed: [...viewFiles, ...rootFiles.filter((f) => LIVE_VIDEO.test(f.name))],
    };
  }

  async _delete(files) {
    let freed = 0;
    for (const f of files) {
      try {
        await FileSystem.deleteAsync(f.uri, { idempotent: true });
        freed += f.size;
      } catch (e) {
        console.warn(`[StorageService] Could not delete ${f.name}:`, e?.message);
      }
    }
    return freed;
  }

  /**
   * Removes stale temp files and, beyond the user's limit, the oldest managed cache files.
   * Throttled to once per PRUNE_INTERVAL_MS unless forced. Resolves to the bytes freed.
   */
  async prune({ force = false } = {}) {
    if (this._pruning) return this._pruning;
    if (!force && Date.now() - this._lastPruneAt < PRUNE_INTERVAL_MS) return 0;
    this._lastPruneAt = Date.now();
    this._pruning = (async () => {
      try {
        const limitBytes = (await this.getCacheLimitMb()) * MB;
        const { rootFiles, managed } = await this._managedFiles();
        const freed = await this._delete([
          ...pickStaleTemps(rootFiles, Date.now()),
          ...pickEvictions(managed, limitBytes),
        ]);
        if (freed > 0) console.log(`[StorageService] Pruned ${(freed / MB).toFixed(1)} MB of cache.`);
        return freed;
      } catch (e) {
        console.warn('[StorageService] Prune failed:', e?.message);
        return 0;
      } finally {
        this._pruning = null;
      }
    })();
    return this._pruning;
  }

  /**
   * Clears everything rebuildable: the managed files, stale temps and the image loader's disk
   * cache (thumbnails and previews come back from the server as they are shown again).
   */
  async clearCache() {
    const { rootFiles, managed } = await this._managedFiles();
    const freed = await this._delete([...managed, ...pickStaleTemps(rootFiles, Date.now())]);
    try {
      const { Image } = require('expo-image');
      await Image.clearDiskCache?.();
      Image.clearMemoryCache?.();
    } catch (e) {
      console.warn('[StorageService] Could not clear the image cache:', e?.message);
    }
    return freed;
  }

  /**
   * Bytes used, by kind. cache is the whole cache directory (thumbnails, previews, video
   * buffering, temp files), which the system may also clear when space runs low.
   */
  async getUsage() {
    const doc = FileSystem.documentDirectory || '';
    const { FAVORITES_CACHE_DIR } = require('./OfflineCacheService');
    const [cache, favorites, models, database] = await Promise.all([
      FileSystem.cacheDirectory ? sizeOf(FileSystem.cacheDirectory) : 0,
      sizeOf(FAVORITES_CACHE_DIR),
      sizeOf(`${doc}models/`),
      sizeOf(`${doc}SQLite/`),
    ]);
    return { cache, favorites, models, database };
  }
}

export default new StorageService();
