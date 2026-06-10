import AssetDBService from '../AssetDBService';
import * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => {
  const mockStatement = {
    executeAsync: jest.fn().mockResolvedValue({}),
    finalizeAsync: jest.fn().mockResolvedValue({}),
  };
  const mockDb = {
    execAsync: jest.fn().mockResolvedValue({}),
    withExclusiveTransactionAsync: jest.fn(async (cb) => cb()),
    prepareAsync: jest.fn().mockResolvedValue(mockStatement),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue(null),
  };
  return {
    openDatabaseAsync: jest.fn().mockResolvedValue(mockDb),
  };
});

describe('AssetDBService', () => {
  let mockDb;
  let mockStatement;

  beforeEach(async () => {
    jest.clearAllMocks();
    AssetDBService.db = null; // Reset database state
    await AssetDBService.init();
    mockDb = await SQLite.openDatabaseAsync();
    mockStatement = await mockDb.prepareAsync();
  });

  test('init initializes database and executes table creation & migration', async () => {
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('lomoAssets.db');
    expect(mockDb.execAsync).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS MediaAsset'));
    expect(mockDb.execAsync).toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE MediaAsset ADD COLUMN filename TEXT'));
  });

  test('insertLocalAssets inserts local assets successfully within transaction', async () => {
    const mockAssets = [
      { id: '1', creationTime: 123456, mediaType: 'photo', location: { latitude: 12.3, longitude: 45.6 } }
    ];

    await AssetDBService.insertLocalAssets(mockAssets);

    expect(mockDb.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockDb.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO MediaAsset'));
    expect(mockStatement.executeAsync).toHaveBeenCalledWith(
      '1',
      1,
      12.3,
      45.6,
      123456,
      'photo'
    );
    expect(mockStatement.finalizeAsync).toHaveBeenCalled();
  });

  test('insertRemoteAssets inserts remote assets with filename and mediaType', async () => {
    const mockRemoteAssets = [
      { hash: 'h1', date: new Date('2024-01-01T12:00:00Z'), tag: 'pic.jpg' },
      { hash: 'h2', date: new Date('2024-02-01T12:00:00Z'), tag: 'movie.mp4' }
    ];

    await AssetDBService.insertRemoteAssets(mockRemoteAssets);

    expect(mockDb.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockDb.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO MediaAsset'));
    
    // First remote asset (pic.jpg -> photo)
    expect(mockStatement.executeAsync).toHaveBeenNthCalledWith(
      1,
      'h1',
      'h1',
      new Date('2024-01-01T12:00:00Z').getTime(),
      'photo',
      'pic.jpg'
    );

    // Second remote asset (movie.mp4 -> video)
    expect(mockStatement.executeAsync).toHaveBeenNthCalledWith(
      2,
      'h2',
      'h2',
      new Date('2024-02-01T12:00:00Z').getTime(),
      'video',
      'movie.mp4'
    );
  });

  test('getRemoteAssets queries remote assets and maps them correctly', async () => {
    mockDb.getAllAsync.mockResolvedValue([
      { hash: 'h1', filename: 'pic.jpg', createTime: 123456, mediaType: 'photo' }
    ]);

    const result = await AssetDBService.getRemoteAssets();

    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT hash, filename, createTime, mediaType FROM MediaAsset WHERE isLocal = 0')
    );
    expect(result).toEqual([
      {
        id: 'remote-h1',
        hash: 'h1',
        filename: 'pic.jpg',
        creationTime: 123456,
        mediaType: 'photo'
      }
    ]);
  });

  test('getRemoteAssetsCount returns total count of remote assets', async () => {
    mockDb.getFirstAsync.mockResolvedValue({ count: 42 });

    const count = await AssetDBService.getRemoteAssetsCount();

    expect(mockDb.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*) as count FROM MediaAsset WHERE isLocal = 0')
    );
    expect(count).toBe(42);
  });

  test('updateRemoteAssetFilenames updates filenames and mediaTypes for remote assets', async () => {
    const updates = [
      { hash: 'h1', filename: 'healed.jpg', mediaType: 'photo' }
    ];

    await AssetDBService.updateRemoteAssetFilenames(updates);

    expect(mockDb.withExclusiveTransactionAsync).toHaveBeenCalled();
    expect(mockDb.prepareAsync).toHaveBeenCalledWith(expect.stringContaining('UPDATE MediaAsset SET filename = ?, mediaType = ? WHERE id = ?'));
    expect(mockStatement.executeAsync).toHaveBeenCalledWith(
      'healed.jpg',
      'photo',
      'h1'
    );
  });

  test('getLocalAssetsWithoutGeo returns local assets without geo details', async () => {
    mockDb.getAllAsync.mockResolvedValue([
      { id: '1' },
      { id: '2' }
    ]);

    const result = await AssetDBService.getLocalAssetsWithoutGeo(10);

    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM MediaAsset WHERE isLocal = 1 AND hasGeo = 0 LIMIT ?'),
      [10]
    );
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });
});
