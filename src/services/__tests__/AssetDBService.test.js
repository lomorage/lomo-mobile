import AssetDBService from '../AssetDBService';
import * as SQLite from 'expo-sqlite';

let mockDbInstance;
let mockStatementInstance;
const mockSpies = {
  execAsync: null,
  runAsync: null,
  withExclusiveTransactionAsync: null,
  withTransactionAsync: null,
  getAllAsync: null,
  getFirstAsync: null,
  prepareAsync: null,
};

jest.mock('expo-sqlite', () => {
  return {
    openDatabaseAsync: jest.fn().mockImplementation(() => {
      mockStatementInstance = {
        executeAsync: jest.fn().mockResolvedValue({}),
        executeSync: jest.fn(),
        finalizeAsync: jest.fn().mockResolvedValue({}),
      };
      mockDbInstance = {
        execAsync: jest.fn().mockResolvedValue({}),
        withExclusiveTransactionAsync: jest.fn(async (cb) => cb()),
        withTransactionAsync: jest.fn(async (cb) => cb()),
        prepareAsync: jest.fn().mockResolvedValue(mockStatementInstance),
        getAllAsync: jest.fn().mockResolvedValue([]),
        getFirstAsync: jest.fn().mockResolvedValue({ user_version: 0 }),
        runAsync: jest.fn().mockResolvedValue({}),
      };
      
      mockSpies.execAsync = mockDbInstance.execAsync;
      mockSpies.runAsync = mockDbInstance.runAsync;
      mockSpies.withExclusiveTransactionAsync = mockDbInstance.withExclusiveTransactionAsync;
      mockSpies.withTransactionAsync = mockDbInstance.withTransactionAsync;
      mockSpies.getAllAsync = mockDbInstance.getAllAsync;
      mockSpies.getFirstAsync = mockDbInstance.getFirstAsync;
      mockSpies.prepareAsync = mockDbInstance.prepareAsync;

      return Promise.resolve(mockDbInstance);
    }),
  };
});

describe('AssetDBService', () => {
  let mockDb;
  let mockStatement;

  beforeEach(async () => {
    jest.clearAllMocks();
    AssetDBService.db = null; // Reset database state
    AssetDBService.writePromise = Promise.resolve(); // Reset write queue to prevent hangs
    await AssetDBService.init();
    mockDb = mockDbInstance;
    mockStatement = mockStatementInstance;
  });

  test('init initializes database and executes table creation & migration', async () => {
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('lomoAssets.db');
    expect(mockSpies.execAsync).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS MediaAsset'));
    expect(mockSpies.execAsync).toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE MediaAsset ADD COLUMN filename TEXT'));
  });

  test('insertLocalAssets inserts local assets successfully within transaction', async () => {
    const mockAssets = [
      { id: '1', creationTime: 123456, mediaType: 'photo', location: { latitude: 12.3, longitude: 45.6 } }
    ];

    await AssetDBService.insertLocalAssets(mockAssets);

    expect(mockSpies.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockSpies.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO MediaAsset'));
    expect(mockStatement.executeSync).toHaveBeenCalledWith(
      '1',
      1,
      12.3,
      45.6,
      123456,
      'photo'
    );
    expect(mockStatement.finalizeAsync).toHaveBeenCalled();
  });

  test('syncRemoteAssets inserts remote assets with filename and mediaType', async () => {
    const mockRemoteAssets = [
      { hash: 'h1', date: new Date('2024-01-01T12:00:00Z'), tag: 'pic.jpg' },
      { hash: 'h2', date: new Date('2024-02-01T12:00:00Z'), tag: 'movie.mp4' }
    ];

    await AssetDBService.syncRemoteAssets(mockRemoteAssets);

    expect(mockSpies.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockSpies.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO MediaAsset'));
    
    // First remote asset (pic.jpg -> photo)
    expect(mockStatement.executeSync).toHaveBeenNthCalledWith(
      1,
      'h1',
      'h1',
      new Date('2024-01-01T12:00:00Z').getTime(),
      'photo',
      'pic.jpg'
    );

    // Second remote asset (movie.mp4 -> video)
    expect(mockStatement.executeSync).toHaveBeenNthCalledWith(
      2,
      'h2',
      'h2',
      new Date('2024-02-01T12:00:00Z').getTime(),
      'video',
      'movie.mp4'
    );
  });

  test('getRemoteAssets queries remote assets and maps them correctly', async () => {
    mockSpies.getAllAsync.mockResolvedValue([
      { hash: 'h1', filename: 'pic.jpg', createTime: 123456, mediaType: 'photo' }
    ]);

    const result = await AssetDBService.getRemoteAssets();

    expect(mockSpies.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT hash, filename, createTime, mediaType, isFavorite, localCachePath FROM MediaAsset WHERE isLocal = 0 ORDER BY createTime DESC')
    );
    expect(result).toEqual([
      {
        id: 'remote-h1',
        hash: 'h1',
        filename: 'pic.jpg',
        creationTime: 123456,
        mediaType: 'photo',
        isFavorite: false,
        localCachePath: undefined
      }
    ]);
  });

  test('getRemoteAssetsCount returns total count of remote assets', async () => {
    mockSpies.getFirstAsync.mockResolvedValue({ count: 42 });

    const count = await AssetDBService.getRemoteAssetsCount();

    expect(mockSpies.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*) as count FROM MediaAsset WHERE isLocal = 0')
    );
    expect(count).toBe(42);
  });

  test('updateRemoteAssetFilenames updates filenames and mediaTypes for remote assets', async () => {
    const updates = [
      { hash: 'h1', filename: 'healed.jpg', mediaType: 'photo' }
    ];

    await AssetDBService.updateRemoteAssetFilenames(updates);

    expect(mockSpies.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockSpies.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('UPDATE MediaAsset SET filename = ?, mediaType = ? WHERE id = ?'));
    expect(mockStatement.executeSync).toHaveBeenCalledWith(
      'healed.jpg',
      'photo',
      'h1'
    );
  });

  test('getLocalAssetsWithoutGeo returns local assets without geo details', async () => {
    mockSpies.getAllAsync.mockResolvedValue([
      { id: '1' },
      { id: '2' }
    ]);

    const result = await AssetDBService.getLocalAssetsWithoutGeo(10);

    expect(mockSpies.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM MediaAsset WHERE isLocal = 1 AND hasGeo = 0 LIMIT ?'),
      [10]
    );
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });
});
