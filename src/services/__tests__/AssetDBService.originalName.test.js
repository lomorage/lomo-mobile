// The original file name (IMG_1234.HEIC) of photos only on the server: what the real SQL keeps,
// reports and records. Runs against Node's built-in SQLite; skipped where it is unavailable.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_unavailable) {
  DatabaseSync = null;
}

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const AssetDBService = require('../AssetDBService').default;

const describeWithSqlite = DatabaseSync ? describe : describe.skip;

const BASE_COLUMNS = `id TEXT PRIMARY KEY, hash TEXT, isLocal INTEGER NOT NULL DEFAULT 0, hasGeo INTEGER NOT NULL DEFAULT 0,
  latitude REAL DEFAULT 0.0, longitude REAL DEFAULT 0.0, createTime INTEGER DEFAULT 0, mediaType TEXT,
  filename TEXT, isFavorite INTEGER DEFAULT 0, localCachePath TEXT, phash TEXT, clipEmbedding TEXT,
  ocrText TEXT, uploaded INTEGER DEFAULT 0, fileSize INTEGER, backupExcluded INTEGER DEFAULT 0,
  faceRecVersion INTEGER`;

describeWithSqlite('original file names (real SQLite)', () => {
  let sqlite;
  let previous;

  // The slice of the expo-sqlite API the methods under test use.
  const adapter = () => ({
    runAsync: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql, params = []) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => sqlite.prepare(sql).get(...params),
    withExclusiveTransactionAsync: async (fn) => fn(),
    prepareAsync: async (sql) => {
      const statement = sqlite.prepare(sql);
      return { executeSync: (...args) => statement.run(...args), finalizeAsync: async () => {} };
    },
  });

  const insert = (row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO MediaAsset (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((c) => row[c]));
  };
  const local = (id, hash, filename, extra = {}) =>
    insert({ id, hash, isLocal: 1, uploaded: 1, mediaType: 'photo', filename, createTime: 1000, ...extra });
  // lomod's own name (date+id) is what `filename` holds for a remote row.
  const remote = (hash, extra = {}) =>
    insert({ id: hash, hash, isLocal: 0, mediaType: 'photo', filename: `${hash}-server.jpg`, createTime: 1000, ...extra });
  const byId = (id) => sqlite.prepare('SELECT * FROM MediaAsset WHERE id = ?').get(id);

  const setUp = (withColumns) => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE MediaAsset (${BASE_COLUMNS}${
      withColumns ? ', originalName TEXT, originalNameSynced INTEGER DEFAULT 0' : ''})`);
    previous = { db: AssetDBService.db, has: AssetDBService.hasOriginalName };
    AssetDBService.db = adapter();
    AssetDBService.hasOriginalName = withColumns;
  };
  afterEach(() => {
    AssetDBService.db = previous.db;
    AssetDBService.hasOriginalName = previous.has;
    sqlite.close();
  });

  describe('with the version 18 columns', () => {
    beforeEach(() => setUp(true));

    test('Free Up Space keeps the phone name on the server row that remains', async () => {
      local('phone-1', 'h1', 'IMG_1234.HEIC');
      remote('h1');

      await AssetDBService.markAssetsRemovedLocally(['phone-1']);

      expect(byId('phone-1')).toBeUndefined();
      expect(byId('h1')).toMatchObject({ filename: 'h1-server.jpg', originalName: 'IMG_1234.HEIC' });
    });

    test('a name the server row already has is not replaced', async () => {
      local('phone-1', 'h1', 'IMG_copy.HEIC');
      remote('h1', { originalName: 'IMG_1234.HEIC', originalNameSynced: 1 });

      await AssetDBService.markAssetsRemovedLocally(['phone-1']);

      expect(byId('h1').originalName).toBe('IMG_1234.HEIC');
    });

    test('a freed photo not yet synced down keeps its name too', async () => {
      local('phone-1', 'h1', 'PXL_1.jpg');

      await AssetDBService.markAssetsRemovedLocally(['phone-1']);

      expect(byId('h1')).toMatchObject({ isLocal: 0, originalName: 'PXL_1.jpg' });
    });

    test('names to report: from the photo on the phone, or the one kept, not ones the server confirmed', async () => {
      remote('h1');
      local('phone-1', 'h1', 'IMG_1.jpg');
      remote('h2', { originalName: 'IMG_2.jpg' }); // kept by Free Up Space, not confirmed
      remote('h3', { originalName: 'IMG_3.jpg', originalNameSynced: 1 });
      local('phone-3', 'h3', 'IMG_3.jpg');
      remote('h4'); // no name known anywhere
      local('phone-5', 'h5', 'IMG_5.jpg'); // not on the server

      const names = await AssetDBService.getOriginalNamesToReport();

      expect(names.sort((a, b) => a.hash.localeCompare(b.hash))).toEqual([
        { hash: 'h1', name: 'IMG_1.jpg' },
        { hash: 'h2', name: 'IMG_2.jpg' },
      ]);
    });

    test('names to report honour the limit and the hashes already tried', async () => {
      for (let i = 0; i < 5; i += 1) remote(`h${i}`, { originalName: `IMG_${i}.jpg` });

      const names = await AssetDBService.getOriginalNamesToReport(2, new Set(['h0']));

      expect(names).toHaveLength(2);
      expect(names.map((n) => n.hash)).not.toContain('h0');
    });

    test('a confirmed name is recorded; an empty answer confirms without wiping a kept name', async () => {
      remote('h1');
      remote('h2', { originalName: 'IMG_2.jpg' });
      local('phone-1', 'h1', 'IMG_1.jpg');

      await AssetDBService.setRemoteOriginalNames([
        { hash: 'H1', name: 'IMG_first.jpg' }, // the server kept an earlier name
        { hash: 'h2', name: '' },
      ]);

      expect(byId('h1')).toMatchObject({ originalName: 'IMG_first.jpg', originalNameSynced: 1 });
      expect(byId('h2')).toMatchObject({ originalName: 'IMG_2.jpg', originalNameSynced: 1 });
      expect(byId('phone-1').originalName).toBeNull(); // the phone's own row is left alone
      await expect(AssetDBService.getOriginalNamesToReport()).resolves.toEqual([]);
    });

    test('a server listing with names fills new rows and unconfirmed ones, and leaves confirmed ones', async () => {
      remote('h1');
      remote('h2', { originalName: 'kept.jpg', originalNameSynced: 1 });
      const node = (hash, origName) => ({ hash, tag: `${hash}-server.jpg`, date: new Date(5000), origName });

      await AssetDBService.syncRemoteAssets([
        node('h1', 'IMG_1.jpg'),
        node('h2', 'IMG_2.jpg'),
        node('h3', 'IMG_3.jpg'),
        node('h4', null),
      ]);

      expect(byId('h1')).toMatchObject({ originalName: 'IMG_1.jpg', originalNameSynced: 1 });
      expect(byId('h2')).toMatchObject({ originalName: 'kept.jpg', originalNameSynced: 1 });
      expect(byId('h3')).toMatchObject({ filename: 'h3-server.jpg', originalName: 'IMG_3.jpg', originalNameSynced: 1 });
      expect(byId('h4')).toMatchObject({ originalName: null, originalNameSynced: 0 });
    });

    test('sync state is kept per key and replaced on update', async () => {
      sqlite.exec('CREATE TABLE IF NOT EXISTS SyncState (key TEXT PRIMARY KEY, value TEXT)');
      await expect(AssetDBService.getSyncState('originalNamesRev:a')).resolves.toBeNull();
      await AssetDBService.setSyncState('originalNamesRev:a', 7);
      await AssetDBService.setSyncState('originalNamesRev:a', 9);
      await AssetDBService.setSyncState('originalNamesRev:b', 1);
      await expect(AssetDBService.getSyncState('originalNamesRev:a')).resolves.toBe('9');
      await expect(AssetDBService.getSyncState('originalNamesRev:b')).resolves.toBe('1');
    });

    test('the gallery gets the original name next to the server one', async () => {
      remote('h1', { originalName: 'IMG_1.jpg' });

      const [asset] = await AssetDBService.getRemoteAssets();
      expect(asset).toMatchObject({ filename: 'h1-server.jpg', originalName: 'IMG_1.jpg' });
      const [byHash] = await AssetDBService.getAssetsByHashes(['h1']);
      expect(byHash).toMatchObject({ filename: 'h1-server.jpg', originalName: 'IMG_1.jpg' });
    });
  });

  describe('on a database that did not take version 18', () => {
    beforeEach(() => setUp(false));

    test('reading, syncing and freeing space still work, without names', async () => {
      remote('h1');
      local('phone-2', 'h2', 'IMG_2.jpg');

      await AssetDBService.syncRemoteAssets([{ hash: 'h1', tag: 'h1-server.jpg', date: new Date(5000), origName: 'IMG_1.jpg' }]);
      await AssetDBService.markAssetsRemovedLocally(['phone-2']);

      const assets = await AssetDBService.getRemoteAssets();
      expect(assets.map((a) => [a.hash, a.originalName])).toEqual([['h1', null], ['h2', null]]);
      await expect(AssetDBService.getOriginalNamesToReport()).resolves.toEqual([]);
      await expect(AssetDBService.setRemoteOriginalNames([{ hash: 'h1', name: 'x' }])).resolves.toBeUndefined();
    });
  });
});
