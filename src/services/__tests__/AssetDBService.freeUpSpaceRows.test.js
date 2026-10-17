// Runs the real SQL of markAssetsRemovedLocally / getAtHomeCounts against a real SQLite
// (Node's built-in node:sqlite), because the bug it covers was about what the statements do to
// rows, which a mocked database cannot show. Skipped where node:sqlite is not available.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import AssetDBService from '../AssetDBService';

const describeWithSqlite = DatabaseSync ? describe : describe.skip;

describeWithSqlite('markAssetsRemovedLocally (real SQLite)', () => {
  let sqlite;
  let previousDb;

  // The slice of the expo-sqlite API the methods under test use.
  const adapter = () => ({
    runAsync: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql, params = []) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => sqlite.prepare(sql).get(...params),
  });

  const insert = (row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO MediaAsset (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((c) => row[c]));
  };
  // A photo on the phone, backed up, with what the phone worked out about it.
  const local = (id, hash, extra = {}) =>
    insert({ id, hash, isLocal: 1, uploaded: 1, mediaType: 'photo', filename: `${id}.jpg`, createTime: 1000, ...extra });
  // What the server sync mirrors: keyed by the file's hash.
  const remote = (hash, extra = {}) =>
    insert({ id: hash, hash, isLocal: 0, mediaType: 'photo', filename: `${hash}.jpg`, createTime: 1000, ...extra });
  const rows = () => sqlite.prepare('SELECT * FROM MediaAsset ORDER BY id').all();
  const byId = (id) => sqlite.prepare('SELECT * FROM MediaAsset WHERE id = ?').get(id);

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE MediaAsset (
      id TEXT PRIMARY KEY, hash TEXT, isLocal INTEGER NOT NULL DEFAULT 0, hasGeo INTEGER NOT NULL DEFAULT 0,
      latitude REAL DEFAULT 0.0, longitude REAL DEFAULT 0.0, createTime INTEGER DEFAULT 0, mediaType TEXT,
      filename TEXT, isFavorite INTEGER DEFAULT 0, localCachePath TEXT, phash TEXT, clipEmbedding TEXT,
      ocrText TEXT, uploaded INTEGER DEFAULT 0, fileSize INTEGER, backupExcluded INTEGER DEFAULT 0
    )`);
    previousDb = AssetDBService.db;
    AssetDBService.db = adapter();
  });
  afterEach(() => {
    AssetDBService.db = previousDb;
    sqlite.close();
  });

  test('a freed photo that the server has already mirrored ends up as one row, not two', async () => {
    local('phone-1', 'H1');
    remote('H1');

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(rows().map((r) => [r.id, r.isLocal])).toEqual([['H1', 0]]);
  });

  test('what the phone worked out is kept on the remaining row', async () => {
    local('phone-1', 'H1', { phash: 'ph-local', clipEmbedding: 'clip-local', ocrText: 'Park picnic' });
    remote('H1');

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(byId('H1')).toMatchObject({ phash: 'ph-local', clipEmbedding: 'clip-local', ocrText: 'Park picnic' });
  });

  test('values the remote row already has are not overwritten, and "failed" markers do not spread', async () => {
    local('phone-1', 'H1', { phash: 'ph-local', clipEmbedding: 'failed', ocrText: 'local text' });
    remote('H1', { phash: 'ph-remote', clipEmbedding: 'clip-remote', ocrText: '' });

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(byId('H1')).toMatchObject({ phash: 'ph-remote', clipEmbedding: 'clip-remote', ocrText: 'local text' });
  });

  test('a "failed" marker on the remote row is replaced by a good local value', async () => {
    local('phone-1', 'H1', { clipEmbedding: 'clip-local' });
    remote('H1', { clipEmbedding: 'failed' });

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(byId('H1').clipEmbedding).toBe('clip-local');
  });

  test('without a remote row yet, the local row becomes the remote one, keyed by the hash', async () => {
    local('phone-1', 'H1', { phash: 'ph-local', filename: 'PXL_1.jpg', createTime: 5000 });

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(rows()).toHaveLength(1);
    expect(byId('H1')).toMatchObject({ isLocal: 0, hash: 'H1', phash: 'ph-local', filename: 'PXL_1.jpg', createTime: 5000 });
    expect(byId('phone-1')).toBeUndefined();
  });

  test('a later server sync neither duplicates nor drops it (the row is keyed like a synced one)', async () => {
    local('phone-1', 'H1');
    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    // What syncRemoteAssets does for a hash it already has: INSERT OR IGNORE keyed by hash.
    sqlite.prepare('INSERT OR IGNORE INTO MediaAsset (id, hash, isLocal) VALUES (?, ?, 0)').run('H1', 'H1');
    expect(rows().filter((r) => r.hash === 'H1')).toHaveLength(1);
  });

  test('two copies of one file on the phone do not break it and leave a single row', async () => {
    local('phone-1', 'H1');
    local('phone-2', 'H1');

    await AssetDBService.markAssetsRemovedLocally(['phone-1', 'phone-2']);

    expect(rows().map((r) => [r.id, r.isLocal])).toEqual([['H1', 0]]);
  });

  test('nothing is left flagged as being on the phone, and other photos are untouched', async () => {
    local('phone-1', 'H1');
    remote('H1');
    local('phone-keep', 'H2'); // still on the phone
    remote('H2');
    remote('H3'); // only on the computer
    local('phone-unbacked', null, { uploaded: 0 }); // not backed up, still on the phone

    await AssetDBService.markAssetsRemovedLocally(['phone-1']);

    expect(rows().map((r) => [r.id, r.isLocal])).toEqual([
      ['H1', 0], ['H2', 0], ['H3', 0], ['phone-keep', 1], ['phone-unbacked', 1],
    ]);
  });

  test('a long list is handled in chunks', async () => {
    const ids = [];
    for (let i = 0; i < 450; i += 1) {
      local(`phone-${i}`, `H${i}`, { phash: `ph-${i}` });
      if (i % 2 === 0) remote(`H${i}`); // half already mirrored by the server
      ids.push(`phone-${i}`);
    }

    await AssetDBService.markAssetsRemovedLocally(ids);

    const all = rows();
    expect(all).toHaveLength(450);
    expect(all.every((r) => r.isLocal === 0 && r.id === r.hash)).toBe(true);
    expect(byId('H0').phash).toBe('ph-0');
    expect(byId('H449').phash).toBe('ph-449');
  });

  test('an empty list does nothing', async () => {
    local('phone-1', 'H1');
    await AssetDBService.markAssetsRemovedLocally([]);
    expect(byId('phone-1')).toMatchObject({ isLocal: 1 });
  });

  test('getAtHomeCounts counts only what the computer holds, split by type', async () => {
    remote('H1');
    remote('H2');
    remote('V1', { mediaType: 'video' });
    local('phone-1', 'H9'); // on the phone only: not counted

    await expect(AssetDBService.getAtHomeCounts()).resolves.toEqual({ photos: 2, videos: 1 });
  });

  test('freeing space leaves the at-home count equal to the library, not doubled', async () => {
    for (let i = 0; i < 10; i += 1) {
      local(`phone-${i}`, `H${i}`);
      remote(`H${i}`);
    }
    await AssetDBService.markAssetsRemovedLocally(Array.from({ length: 10 }, (_, i) => `phone-${i}`));

    await expect(AssetDBService.getAtHomeCounts()).resolves.toEqual({ photos: 10, videos: 0 });
    expect(rows()).toHaveLength(10);
  });
});
