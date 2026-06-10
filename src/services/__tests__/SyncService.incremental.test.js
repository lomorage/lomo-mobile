import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(uri => Promise.resolve(`hash_${uri.split('/').pop()}`)),
  getAssetInfo: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/doc/dir/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue('{}'),
}));

jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'test-token',
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn((algo, str) => Promise.resolve(`digest_${str}`)),
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
}));

jest.mock('../AssetDBService', () => ({
  init: jest.fn().mockResolvedValue(),
  insertRemoteAssets: jest.fn().mockResolvedValue(),
  getRemoteAssetsWithoutGeo: jest.fn().mockResolvedValue([]),
  getLocalAssetsWithoutGeo: jest.fn().mockResolvedValue([]),
  updateAssetsGeo: jest.fn().mockResolvedValue(),
  markAssetsGeoProcessed: jest.fn().mockResolvedValue(),
  getRemoteAssets: jest.fn().mockResolvedValue([]),
  getRemoteAssetsCount: jest.fn().mockResolvedValue(0),
  updateRemoteAssetFilenames: jest.fn().mockResolvedValue(),
}));

jest.mock('axios');

describe('SyncService Incremental Remote Sync', () => {
  beforeEach(() => {
    // Reset trees
    SyncService.localTree = new (SyncService.localTree.constructor)();
    SyncService.remoteTree = new (SyncService.remoteTree.constructor)();
    SyncService.localHashCache = {};
    SyncService.isSyncing = false;
    jest.clearAllMocks();
  });

  test('fetchRemoteMonthLevel performs GET call with auth header', async () => {
    axios.get.mockResolvedValue({ data: { Hash: 'root_hash', Years: [] } });

    const result = await SyncService.fetchRemoteMonthLevel();

    expect(axios.get).toHaveBeenCalledWith('http://localhost:8000/assets/merkletree', {
      headers: { Authorization: 'token=test-token' },
      timeout: 30000,
      skipAutoProbe: true,
    });
    expect(result).toEqual({ Hash: 'root_hash', Years: [] });
  });

  test('fetchRemoteOverview skips full fetch if root hash is unchanged', async () => {
    // Set cached remote tree hash
    SyncService.remoteTree.hash = 'root_hash';

    // Mock month-level response with same root hash
    axios.get.mockResolvedValue({ data: { Hash: 'root_hash', Years: [] } });

    const result = await SyncService.fetchRemoteOverview();

    // axios.get should only be called once (for month-level overview)
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(result).toBe(SyncService.remoteTree);
  });

  test('fetchRemoteOverview only fetches changed months and reuses cached subtrees', async () => {
    // 1. Build initial cached remote tree: Year 2024, Month 1 (Jan) with hash 'hash_jan', Month 2 (Feb) with hash 'hash_feb'
    const cachedTree = SyncService.remoteTree;
    cachedTree.addAsset(2024, 1, 1, 'h1', '1', new Date('2024-01-01T12:00:00Z'));
    cachedTree.addAsset(2024, 2, 1, 'h2', '2', new Date('2024-02-01T12:00:00Z'));
    cachedTree.hash = 'old_root_hash';
    // Set hashes for month nodes manually
    cachedTree.getChild(2024).getChild(1).hash = 'hash_jan';
    cachedTree.getChild(2024).getChild(2).hash = 'hash_feb';

    // 2. Mock new month-level data: Month 1 is unchanged ('hash_jan'), Month 2 is changed ('hash_feb_new')
    const monthLevelData = {
      Hash: 'new_root_hash',
      Years: [
        {
          Year: 2024,
          Hash: 'year_hash',
          Months: [
            { Month: 1, Hash: 'hash_jan' },
            { Month: 2, Hash: 'hash_feb_new' }
          ]
        }
      ]
    };

    // Mock month data for changed month (Month 2)
    const month2DetailData = {
      Days: [
        {
          Day: 1,
          Hash: 'day_hash_new',
          Assets: [
            { Hash: 'h2_new', Name: '2_new', Date: '2024-02-01 12:00:00' }
          ]
        }
      ]
    };

    axios.get.mockImplementation((url) => {
      if (url.endsWith('/assets/merkletree')) {
        return Promise.resolve({ data: monthLevelData });
      }
      if (url.endsWith('/assets/merkletree/2024/2')) {
        return Promise.resolve({ data: month2DetailData });
      }
      return Promise.reject(new Error('Unexpected URL'));
    });

    const result = await SyncService.fetchRemoteOverview();

    // Verify:
    // - Month 1 (Jan) reused cached subtree: asset 'h1' should still be there
    expect(result.getNodeByHash('h1')).toBeDefined();
    // - Month 2 (Feb) updated to new asset 'h2_new'
    expect(result.getNodeByHash('h2_new')).toBeDefined();
    // - Old asset 'h2' is not in the new tree (since Feb was completely refetched and h2 is not in month2DetailData)
    expect(result.getNodeByHash('h2')).toBeUndefined();

    // Verify AssetDBService interaction
    expect(AssetDBService.init).toHaveBeenCalled();
    expect(AssetDBService.insertRemoteAssets).toHaveBeenCalled();

    // Verify only changed month detail was fetched
    expect(axios.get).toHaveBeenCalledTimes(2); // 1 overview + 1 month-level fetch
  });

  test('fetchRemoteOverview falls back to cache on month fetch error', async () => {
    // 1. Build initial cached remote tree: Year 2024, Month 1 (Jan) with hash 'hash_jan'
    const cachedTree = SyncService.remoteTree;
    cachedTree.addAsset(2024, 1, 1, 'h1', '1', new Date('2024-01-01T12:00:00Z'));
    cachedTree.hash = 'old_root_hash';
    cachedTree.getChild(2024).getChild(1).hash = 'hash_jan';

    // 2. Mock month-level data: Month 1 is changed ('hash_jan_new')
    const monthLevelData = {
      Hash: 'new_root_hash',
      Years: [
        {
          Year: 2024,
          Hash: 'year_hash',
          Months: [
            { Month: 1, Hash: 'hash_jan_new' }
          ]
        }
      ]
    };

    axios.get.mockImplementation((url) => {
      if (url.endsWith('/assets/merkletree')) {
        return Promise.resolve({ data: monthLevelData });
      }
      if (url.endsWith('/assets/merkletree/2024/1')) {
        return Promise.reject(new Error('Network error on month fetch'));
      }
      return Promise.reject(new Error('Unexpected URL'));
    });

    const result = await SyncService.fetchRemoteOverview();

    // Verify that we fell back to the cached Jan data (h1) because of the fetch failure
    expect(result.getNodeByHash('h1')).toBeDefined();
  });

  test('_migrateAndHealRemoteAssets triggers bulk migration from JSON if SQLite remote count is 0', async () => {
    // 1. Mock remoteTree loaded from JSON
    const cachedTree = SyncService.remoteTree;
    cachedTree.addAsset(2024, 1, 1, 'h1', '1.jpg', new Date('2024-01-01T12:00:00Z'));
    
    // Mock getRemoteAssetsCount to return 0
    AssetDBService.getRemoteAssetsCount.mockResolvedValue(0);
    
    // Mock DeviceEventEmitter listener to catch the emission
    const mockEmit = jest.fn();
    const { DeviceEventEmitter } = require('react-native');
    const originalEmit = DeviceEventEmitter.emit;
    DeviceEventEmitter.emit = mockEmit;

    try {
      await SyncService._migrateAndHealRemoteAssets();

      // Verify that it initialized the DB
      expect(AssetDBService.init).toHaveBeenCalled();
      // Verify that it checked the remote count
      expect(AssetDBService.getRemoteAssetsCount).toHaveBeenCalled();
      // Verify that it bulk inserted remote assets from tree into SQLite
      expect(AssetDBService.insertRemoteAssets).toHaveBeenCalled();
      expect(AssetDBService.insertRemoteAssets.mock.calls[0][0].length).toBe(1);
      // Verify that it emitted the update event
      expect(mockEmit).toHaveBeenCalledWith('remoteAssetsUpdated');
    } finally {
      // Restore DeviceEventEmitter
      DeviceEventEmitter.emit = originalEmit;
    }
  });

  test('_migrateAndHealRemoteAssets heals NULL filename remote assets in SQLite', async () => {
    // 1. Mock remoteTree loaded from JSON
    const cachedTree = SyncService.remoteTree;
    cachedTree.addAsset(2024, 1, 1, 'h_legacy', 'legacy_pic.jpg', new Date('2024-01-01T12:00:00Z'));
    
    // Mock getRemoteAssetsCount to return 1 (already migrated)
    AssetDBService.getRemoteAssetsCount.mockResolvedValue(1);
    
    // Mock SQLite db object with legacy null rows
    const mockDb = {
      getAllAsync: jest.fn().mockResolvedValue([
        { id: 'h_legacy', hash: 'h_legacy' }
      ])
    };
    AssetDBService.db = mockDb;

    const mockEmit = jest.fn();
    const { DeviceEventEmitter } = require('react-native');
    const originalEmit = DeviceEventEmitter.emit;
    DeviceEventEmitter.emit = mockEmit;

    try {
      await SyncService._migrateAndHealRemoteAssets();

      // Verify it ran the check query for null filenames
      expect(mockDb.getAllAsync).toHaveBeenCalledWith(
        'SELECT id, hash FROM MediaAsset WHERE isLocal = 0 AND filename IS NULL'
      );
      // Verify it healed the filename by updating SQLite
      expect(AssetDBService.updateRemoteAssetFilenames).toHaveBeenCalledWith([
        { hash: 'h_legacy', filename: 'legacy_pic.jpg', mediaType: 'photo' }
      ]);
      expect(mockEmit).toHaveBeenCalledWith('remoteAssetsUpdated');
    } finally {
      DeviceEventEmitter.emit = originalEmit;
      AssetDBService.db = null;
    }
  });
});
