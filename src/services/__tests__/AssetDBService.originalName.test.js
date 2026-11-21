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

    test('names to report come a page at a time after a cursor, each row read once', async () => {
      for (let i = 0; i < 1000; i += 1) {
        const hash = `h${String(i).padStart(4, '0')}`;
        remote(hash, i % 10 === 0 ? {} : { originalName: `IMG_${i}.jpg` }); // every tenth has no name
      }
      const realGetAll = AssetDBService.db.getAllAsync;
      let queries = 0;
      let rowsRead = 0;
      AssetDBService.db.getAllAsync = async (...args) => {
        const rows = await realGetAll(...args);
        queries += 1;
        rowsRead += rows.length;
        return rows;
      };

      const seen = [];
      let after = '';
      for (;;) {
        const page = await AssetDBService.getOriginalNamesToReport(200, after);
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(200);
        seen.push(...page.map((n) => n.hash));
        after = page[page.length - 1].hash;
      }

      expect(seen).toHaveLength(900);
      expect(new Set(seen).size).toBe(900);
      expect(queries).toBe(6); // 5 pages of up to 200, then an empty one
      expect(rowsRead).toBe(900); // not the whole backlog again for every page
    });

    test('with the indexes init makes, a page neither scans nor sorts the table', () => {
      const init = require('fs').readFileSync(require('path').join(__dirname, '..', 'AssetDBService.js'), 'utf8');
      for (const m of init.matchAll(/CREATE INDEX IF NOT EXISTS (idx_isLocal_(?:id|hash)) ON MediaAsset\(([^)]*)\)/g)) {
        sqlite.exec(`CREATE INDEX ${m[1]} ON MediaAsset(${m[2]})`);
      }
      let sql;
      AssetDBService.db.getAllAsync = async (q) => { sql = q; return []; };
      AssetDBService.getOriginalNamesToReport(200, 'h1');
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('h1', 200).map((r) => r.detail).join(' | ');

      expect(plan).toMatch(/idx_isLocal_id/);
      expect(plan).toMatch(/idx_isLocal_hash/);
      expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    });

    test('sync state: nothing recorded is null, a failed read throws', async () => {
      sqlite.exec('CREATE TABLE IF NOT EXISTS SyncState (key TEXT PRIMARY KEY, value TEXT)');
      await expect(AssetDBService.getSyncState('nothing-here')).resolves.toBeNull();
      const realGetFirst = AssetDBService.db.getFirstAsync;
      AssetDBService.db.getFirstAsync = async () => { throw new Error('database is locked'); };
      await expect(AssetDBService.getSyncState('originalNamesAccount')).rejects.toThrow('locked');
      AssetDBService.db.getFirstAsync = realGetFirst;
    });

    test('switching account drops only the names servers confirmed', async () => {
      remote('h1', { originalName: 'A-name.jpg', originalNameSynced: 1 });
      remote('h2', { originalName: 'kept.jpg' }); // this phone's own, from Free Up Space
      local('phone-3', 'h3', 'IMG_3.jpg', { originalName: null });

      await AssetDBService.clearRemoteOriginalNames();

      expect(byId('h1')).toMatchObject({ originalName: null, originalNameSynced: 0 });
      expect(byId('h2')).toMatchObject({ originalName: 'kept.jpg', originalNameSynced: 0 });
      expect(byId('phone-3').filename).toBe('IMG_3.jpg');
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

    test('while the account is not known, the listing adds photos but no names', async () => {
      remote('h1');
      const node = (hash, origName) => ({ hash, tag: `${hash}-server.jpg`, date: new Date(5000), origName });

      await AssetDBService.syncRemoteAssets([node('h1', 'IMG_1.jpg'), node('h2', 'IMG_2.jpg')], { withNames: false });

      expect(byId('h1')).toMatchObject({ originalName: null, originalNameSynced: 0 });
      expect(byId('h2')).toMatchObject({ filename: 'h2-server.jpg', originalName: null, originalNameSynced: 0 });
    });

    test("a sign-in ending while the listing looks up unnamed rows gets none of its names", async () => {
      remote('h1');
      let current = true;
      const realGetAll = AssetDBService.db.getAllAsync;
      AssetDBService.db.getAllAsync = async (sql, ...rest) => {
        const rows = await realGetAll(sql, ...rest);
        if (/originalNameSynced, 0\) = 0/.test(sql)) current = false; // signed in again meanwhile
        return rows;
      };
      const node = (hash, origName) => ({ hash, tag: `${hash}-server.jpg`, date: new Date(5000), origName });

      const result = await AssetDBService.syncRemoteAssets([node('h1', 'IMG_OLD.jpg')], { isCurrent: () => current });

      expect(result).toBe(false);
      expect(byId('h1')).toMatchObject({ originalName: null, originalNameSynced: 0 });
    });

    test('a sign-in ending while the write statement is being prepared gets none of its names', async () => {
      remote('h1');
      let current = true;
      const realPrepare = AssetDBService.db.prepareAsync;
      AssetDBService.db.prepareAsync = async (sql) => {
        const statement = await realPrepare(sql);
        current = false; // switched account and cleaned up while this was paused
        return statement;
      };

      const result = await AssetDBService.setRemoteOriginalNames([{ hash: 'h1', name: 'IMG_OLD.jpg' }],
        { isCurrent: () => current });
      const listed = await AssetDBService.syncRemoteAssets(
        [{ hash: 'h2', tag: 'h2-server.jpg', date: new Date(5000), origName: 'IMG_OLD2.jpg' }],
        { isCurrent: () => current });

      expect(result).toBe(false);
      expect(listed).toBe(false);
      expect(byId('h1')).toMatchObject({ originalName: null, originalNameSynced: 0 });
      expect(byId('h2')).toBeUndefined();
    });

    test('writes go through the connection the transaction hands over', async () => {
      remote('h1');
      const txnPrepare = jest.fn((sql) => AssetDBService.db.prepareAsync(sql));
      const realTxn = AssetDBService.db.withExclusiveTransactionAsync;
      AssetDBService.db.withExclusiveTransactionAsync = (fn) => fn({ prepareAsync: txnPrepare });

      await AssetDBService.setRemoteOriginalNames([{ hash: 'h1', name: 'IMG_1.jpg' }]);

      AssetDBService.db.withExclusiveTransactionAsync = realTxn;
      expect(txnPrepare).toHaveBeenCalledTimes(1);
      expect(byId('h1').originalName).toBe('IMG_1.jpg');
    });

    test('names for a sign-in that ended are not written', async () => {
      remote('h1');

      const result = await AssetDBService.setRemoteOriginalNames([{ hash: 'h1', name: 'IMG_OLD.jpg' }],
        { isCurrent: () => false });

      expect(result).toBe(false);
      expect(byId('h1')).toMatchObject({ originalName: null, originalNameSynced: 0 });
    });

    test('a listing whose sign-in ended writes nothing more', async () => {
      remote('h1');
      const node = (hash, origName) => ({ hash, tag: `${hash}-server.jpg`, date: new Date(5000), origName });

      const result = await AssetDBService.syncRemoteAssets([node('h1', 'IMG_1.jpg'), node('h2', 'IMG_2.jpg')],
        { isCurrent: () => false });

      expect(result).toBe(false);
      expect(byId('h1').originalName).toBeNull();
      expect(byId('h2')).toBeUndefined();
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

    test("while the names may be another account's, reads leave them out", async () => {
      remote('h1', { originalName: 'IMG_A.jpg', originalNameSynced: 1 });

      AssetDBService.hideOriginalNames(true);
      const [hidden] = await AssetDBService.getRemoteAssets();
      AssetDBService.hideOriginalNames(false);
      const [shown] = await AssetDBService.getRemoteAssets();

      expect(hidden.originalName).toBeNull();
      expect(shown.originalName).toBe('IMG_A.jpg');
    });

    test('On This Day gets the original name too', async () => {
      const lastYear = new Date();
      lastYear.setFullYear(lastYear.getFullYear() - 1);
      lastYear.setHours(12, 0, 0, 0);
      remote('h1', { originalName: 'IMG_1.jpg', createTime: lastYear.getTime() });

      const [asset] = await AssetDBService.getOnThisDayAssets();
      expect(asset).toMatchObject({ hash: 'h1', filename: 'h1-server.jpg', originalName: 'IMG_1.jpg' });
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
