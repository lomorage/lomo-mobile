// The refused-upload columns are the one migration whose version is claimed only once the
// columns really exist, because getLocalHashesMap -- where every asset's backed-up status comes
// from -- would otherwise name columns that aren't there and fail on every launch. A database
// that did not take the migration has to degrade to the old behaviour instead.
import AssetDBService from '../AssetDBService';

// AssetDBService.init() wraps every db method in its write queue, so the bare jest.fn()s are
// captured here first: `raw` is what the assertions look at.
let raw;

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const BASE_COLUMNS = ['id', 'hash', 'hashModificationTime', 'uploaded', 'backupExcluded'];
const V17_COLUMNS = [...BASE_COLUMNS, 'uploadRejected', 'uploadRejectedReason'];

// A fake database that reports `columns` for PRAGMA table_info -- which is what the migration
// and init consult to decide whether the refused-upload columns can be named in a query.
const initWith = async (columns) => {
  raw = {
    execAsync: jest.fn(async () => ({})),
    withExclusiveTransactionAsync: jest.fn(async (cb) => cb()),
    withTransactionAsync: jest.fn(async (cb) => cb()),
    prepareAsync: jest.fn(async () => ({
      executeAsync: jest.fn(async () => ({})), finalizeAsync: jest.fn(async () => ({})),
    })),
    getAllAsync: jest.fn(async (sql) => (
      String(sql).includes('PRAGMA table_info') ? columns.map(name => ({ name })) : []
    )),
    getFirstAsync: jest.fn(async () => ({ user_version: 16 })),
    runAsync: jest.fn(async () => ({ changes: 0 })),
  };
  require('expo-sqlite').openDatabaseAsync.mockImplementation(async () => ({ ...raw }));
  AssetDBService.db = null;
  AssetDBService.hasUploadRejected = undefined;
  AssetDBService.writePromise = Promise.resolve();
  await AssetDBService.init();
};

// Answers for the queries under test, with PRAGMA still reporting `columns`.
const queryReturns = (columns, handler) => {
  raw.getAllAsync.mockImplementation(async (sql) => (
    String(sql).includes('PRAGMA table_info') ? columns.map(name => ({ name })) : handler(String(sql))
  ));
};

const ranSql = () => raw.execAsync.mock.calls.map(c => String(c[0])).join(' ');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the refused-upload migration', () => {
  test('claims version 17 once both columns are there', async () => {
    await initWith(V17_COLUMNS);

    expect(ranSql()).toContain('ADD COLUMN uploadRejected INTEGER DEFAULT 0');
    expect(ranSql()).toContain('ADD COLUMN uploadRejectedReason TEXT');
    expect(ranSql()).toContain('PRAGMA user_version = 17');
    expect(AssetDBService.hasUploadRejected).toBe(true);
  });

  test('does not claim version 17 when the columns did not get added', async () => {
    // Left on 16, so the next launch tries again -- rather than claiming a shape the database
    // does not have and breaking the status read for good.
    await initWith(BASE_COLUMNS);

    expect(ranSql()).not.toContain('PRAGMA user_version = 17');
    expect(AssetDBService.hasUploadRejected).toBe(false);
  });
});

describe('a database without the refused-upload columns', () => {
  beforeEach(async () => {
    await initWith(BASE_COLUMNS);
    expect(AssetDBService.hasUploadRejected).toBe(false);
  });

  test('still reads hashes, without naming the missing columns', async () => {
    queryReturns(BASE_COLUMNS, (sql) => {
      expect(sql).not.toContain('uploadRejected');
      return [{ id: 'a1', hash: 'h1', hashModificationTime: 7, uploaded: 1 }];
    });

    await expect(AssetDBService.getLocalHashesMap()).resolves.toEqual({
      a1: { hash: 'h1', modificationTime: 7, uploaded: true, uploadRejected: false, uploadRejectedReason: null },
    });
  });

  test('counts no refusals in the summary rather than failing the query', async () => {
    queryReturns(BASE_COLUMNS, (sql) => {
      expect(sql).toContain('0 AS rejected');
      return [];
    });

    await expect(AssetDBService.getBackupSummaryRows()).resolves.toEqual([]);
  });

  test('recording a refusal is a no-op instead of a failed write', async () => {
    await AssetDBService.markUploadRejected('a1', 'Not implemented');
    await expect(AssetDBService.clearUploadRejected()).resolves.toBe(0);
    await expect(AssetDBService.getUploadRejected()).resolves.toEqual([]);
    expect(raw.runAsync).not.toHaveBeenCalled();
  });
});

describe('a database with the refused-upload columns', () => {
  beforeEach(async () => {
    await initWith(V17_COLUMNS);
  });

  test('records a refusal with the server\'s own wording', async () => {
    await AssetDBService.markUploadRejected('a1', 'Not implemented: extension: avif');

    expect(raw.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET uploadRejected = 1'),
      ['Not implemented: extension: avif', 'a1']
    );
  });

  test('clearing them all reports how many were offered to the queue again', async () => {
    raw.runAsync.mockResolvedValue({ changes: 3 });

    await expect(AssetDBService.clearUploadRejected()).resolves.toBe(3);
    expect(raw.runAsync).toHaveBeenCalledWith(expect.stringContaining('WHERE uploadRejected = 1'));
  });

  test('counts refusals apart, and not twice for an excluded album', async () => {
    queryReturns(V17_COLUMNS, (sql) => {
      // NULL != 1 is NULL in SQL, so a NULL backupExcluded would drop the row from the count.
      expect(sql).toContain('COALESCE(backupExcluded, 0) != 1');
      return [];
    });

    await AssetDBService.getBackupSummaryRows();
  });

  test('reports the refusal through the hash cache the backup queue reads', async () => {
    queryReturns(V17_COLUMNS, () => (
      [{ id: 'a1', hash: 'h1', hashModificationTime: 7, uploaded: 0, uploadRejected: 1, uploadRejectedReason: 'Not implemented' }]
    ));

    const map = await AssetDBService.getLocalHashesMap();
    expect(map.a1.uploadRejected).toBe(true);
    expect(map.a1.uploadRejectedReason).toBe('Not implemented');
  });
});

describe('a refusal belongs to the bytes it was given for', () => {
  test('rehashing clears it in SQL only when the hash changed', async () => {
    await initWith(V17_COLUMNS);

    await AssetDBService.updateAssetHash('a1', 'new-hash', 123.9);

    const [sql, params] = raw.runAsync.mock.calls[raw.runAsync.mock.calls.length - 1];
    expect(sql).toContain('uploadRejected = CASE WHEN hash IS ? THEN uploadRejected ELSE 0 END');
    expect(sql).toContain('uploadRejectedReason = CASE WHEN hash IS ? THEN uploadRejectedReason ELSE NULL END');
    expect(params).toEqual(['new-hash', 123, 'new-hash', 'new-hash', 'a1']);
  });

  test('without the columns it falls back to the plain update', async () => {
    await initWith(BASE_COLUMNS);

    await AssetDBService.updateAssetHash('a1', 'h', 5);

    const [sql] = raw.runAsync.mock.calls[raw.runAsync.mock.calls.length - 1];
    expect(sql).not.toContain('uploadRejected');
  });

  test('the refused list leaves out excluded albums', async () => {
    await initWith(V17_COLUMNS);
    queryReturns(V17_COLUMNS, (sql) => {
      expect(sql).toContain('COALESCE(backupExcluded, 0) != 1');
      return [];
    });

    await expect(AssetDBService.getUploadRejected()).resolves.toEqual([]);
  });
});

describe('recording the camera roll', () => {
  test('stores the file name, so albums and search have one to show', async () => {
    await initWith(V17_COLUMNS);
    const executeSync = jest.fn();
    raw.prepareAsync.mockResolvedValue({ executeSync, finalizeAsync: jest.fn(async () => ({})) });

    await AssetDBService.insertLocalAssets([
      { id: 'x', filename: 'IMG_1.jpg', mediaType: 'photo', creationTime: 5 },
      { id: 'y', mediaType: 'photo' },
    ]);

    const calls = executeSync.mock.calls;
    expect(calls[0][0]).toBe('x');
    expect(calls[0]).toContain('IMG_1.jpg');
    expect(calls[1][calls[1].length - 1]).toBeNull();
  });
});
