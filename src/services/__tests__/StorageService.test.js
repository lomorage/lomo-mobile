// The rebuildable cache must stay within the user's limit, oldest first, and temp files left by
// cut-short work must go once they're old -- without touching anything still in use.
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///doc/',
  readDirectoryAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}) }));
jest.mock('expo-image', () => ({ Image: { clearDiskCache: jest.fn(async () => true), clearMemoryCache: jest.fn() } }));
jest.mock('../OfflineCacheService', () => ({ FAVORITES_CACHE_DIR: 'file:///doc/lomo_favorites/' }));

import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Image } from 'expo-image';
import StorageService, { pickEvictions, pickStaleTemps, DEFAULT_CACHE_LIMIT_MB } from '../StorageService';

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// A fake file system: { dir: { name: { size, ageMs } } }
function useFiles(tree) {
  FileSystem.readDirectoryAsync.mockImplementation(async (dir) => Object.keys(tree[dir] || {}));
  FileSystem.getInfoAsync.mockImplementation(async (uri) => {
    for (const [dir, files] of Object.entries(tree)) {
      if (uri === dir) return { exists: true, isDirectory: true, size: 0 };
      if (uri.startsWith(dir) && files[uri.slice(dir.length)]) {
        const f = files[uri.slice(dir.length)];
        return { exists: true, isDirectory: false, size: f.size, modificationTime: (NOW - f.ageMs) / 1000 };
      }
    }
    return { exists: false };
  });
}
const deleted = () => FileSystem.deleteAsync.mock.calls.map(([uri]) => uri);

describe('pickEvictions', () => {
  const files = [
    { name: 'new', size: 300 * MB, mtimeMs: 3 },
    { name: 'old', size: 300 * MB, mtimeMs: 1 },
    { name: 'mid', size: 300 * MB, mtimeMs: 2 },
  ];

  test('removes the oldest files until the rest fit', () => {
    expect(pickEvictions(files, 500 * MB).map((f) => f.name)).toEqual(['old', 'mid']);
  });

  test('removes nothing under the limit, or with no limit', () => {
    expect(pickEvictions(files, 1000 * MB)).toEqual([]);
    expect(pickEvictions(files, 0)).toEqual([]);
  });
});

describe('pickStaleTemps', () => {
  const f = (name, ageMs) => ({ name, size: 1, mtimeMs: NOW - ageMs });

  test('an upload copy is kept for a day, so a slow upload keeps its file', () => {
    expect(pickStaleTemps([f('ABC.raw', 2 * HOUR)], NOW)).toEqual([]);
    expect(pickStaleTemps([f('ABC.raw', 25 * HOUR)], NOW)).toHaveLength(1);
  });

  test('one-off temps go after an hour, including originals Duplicates used to leave in the root', () => {
    const sha = 'a'.repeat(40);
    const old = [f('similar_temp_x.jpg', 2 * HOUR), f(`${sha}.jpg`, 2 * HOUR), f(sha, 2 * HOUR)];
    expect(pickStaleTemps(old, NOW)).toHaveLength(3);
    expect(pickStaleTemps([f(`${sha}.jpg`, 10 * 60 * 1000)], NOW)).toEqual([]);
  });

  test('never picks the app log or anything it does not recognise', () => {
    expect(pickStaleTemps([f('lomorage_app.log', 100 * HOUR), f('notes.txt', 100 * HOUR)], NOW)).toEqual([]);
  });
});

describe('StorageService.prune', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    StorageService._lastPruneAt = 0;
    SecureStore.getItemAsync.mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  test('keeps Live Photo videos and viewed originals within the default limit, oldest first', async () => {
    useFiles({
      'file:///cache/': {
        'old.mov': { size: 300 * MB, ageMs: 3 * HOUR },
        'new.mov': { size: 150 * MB, ageMs: 1 * HOUR },
        'lomorage_app.log': { size: 1 * MB, ageMs: 100 * HOUR },
      },
      'file:///cache/lomo_view/': {
        'h1': { size: 100 * MB, ageMs: 2 * HOUR },
      },
    });
    expect(DEFAULT_CACHE_LIMIT_MB).toBe(500);

    await StorageService.prune();

    // 550 MB managed -> drop the oldest (old.mov) to get under 500 MB.
    expect(deleted()).toEqual(['file:///cache/old.mov']);
  });

  test('is throttled unless forced', async () => {
    useFiles({ 'file:///cache/': {} });
    await StorageService.prune();
    FileSystem.readDirectoryAsync.mockClear();
    await StorageService.prune();
    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
    await StorageService.prune({ force: true });
    expect(FileSystem.readDirectoryAsync).toHaveBeenCalled();
  });

  test('a lower limit takes effect at once', async () => {
    useFiles({ 'file:///cache/': { 'a.mov': { size: 300 * MB, ageMs: HOUR } } });
    SecureStore.getItemAsync.mockResolvedValue('250');
    await StorageService.setCacheLimitMb(250);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomo_cache_limit_mb', '250');
    expect(deleted()).toEqual(['file:///cache/a.mov']);
  });
});

describe('StorageService.clearCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  test('clears managed files and the image cache, but not an upload in progress', async () => {
    useFiles({
      'file:///cache/': {
        'a.mov': { size: 10 * MB, ageMs: 60 * 1000 },
        'UPLOADING.raw': { size: 900 * MB, ageMs: 5 * 60 * 1000 },
      },
      'file:///cache/lomo_view/': { 'h1': { size: 5 * MB, ageMs: 60 * 1000 } },
    });

    await StorageService.clearCache();

    expect(deleted().sort()).toEqual(['file:///cache/a.mov', 'file:///cache/lomo_view/h1']);
    expect(Image.clearDiskCache).toHaveBeenCalled();
  });
});
