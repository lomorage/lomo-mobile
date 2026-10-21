jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock-cache/',
  documentDirectory: 'file:///mock-doc/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  deleteAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn().mockResolvedValue({ isConnected: true }),
}));
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1),
  getBatteryStateAsync: jest.fn().mockResolvedValue(2),
  BatteryState: { CHARGING: 2 },
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));
jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
jest.mock('expo-media-library', () => ({}));
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
}));
jest.mock('./../AssetDBService', () => ({
  db: null,
  saveAssetOCR: jest.fn(),
  saveAssetMetadata: jest.fn(),
  markLocationChecked: jest.fn(),
  saveAssetEmbeddingsBatch: jest.fn().mockResolvedValue(),
  saveAssetPHashesBatch: jest.fn().mockResolvedValue(),
  saveAssetOCRBatch: jest.fn().mockResolvedValue(),
  ensureRemoteMirrorRowsBatch: jest.fn().mockResolvedValue(),
}));
jest.mock('./../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
  determineBestConnection: jest.fn().mockResolvedValue(),
}));
jest.mock('./../MediaService', () => ({
  getPreviewUrl: jest.fn(),
  getAssetInfo: jest.fn(),
}));
jest.mock('./../ModelAssetService', () => ({
  __esModule: true,
  default: {
    getModelPath: jest.fn(async (name) => name),
    isReady: jest.fn(async () => true),
    isDownloadAllowedNow: jest.fn(async () => true),
    ensureModels: jest.fn(async () => true),
  },
}));
jest.mock('./../TaskSchedulerService', () => ({
  waitUntilIdle: jest.fn().mockResolvedValue(),
}));
jest.mock('@infinitered/react-native-mlkit-text-recognition', () => ({
  recognizeText: jest.fn(),
}));
jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
  RNMLKitFaceDetector: jest.fn().mockImplementation(() => ({
    detectFaces: jest.fn().mockResolvedValue({ faces: [] }),
  })),
}));
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  encodeFaceEmbeddingAsync: jest.fn(),
  encodeImageEmbeddingAsync: jest.fn(),
  encodeTextEmbeddingAsync: jest.fn(),
  sliceFileAsync: jest.fn(),
}));
jest.mock('../../../modules/expo-background-keepalive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })), currentState: 'active' },
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn() },
  Image: { getSize: jest.fn((uri, onSuccess) => onSuccess(200, 200)) },
  PixelRatio: { get: jest.fn(() => 2) },
}));

const SecureStore = require('expo-secure-store');
const AssetDBService = require('./../AssetDBService');
const AuthService = require('./../AuthService');
const { DeviceEventEmitter } = require('react-native');
const axios = require('axios');

import AIService from '../AIService';

function makeEmptyDb() {
  return {
    getFirstAsync: jest.fn().mockResolvedValue({ count: 0 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue(),
  };
}

// Builds a mock `AssetDBService.db` that dispatches on the SQL text so the
// batched Part A (upload) / Part B (download) code paths in syncEmbeddings()
// can be exercised without a real SQLite instance. Any query this doesn't
// recognize (Part C/D's counts/lists, etc.) resolves to "nothing pending",
// so only the upload/download rows explicitly passed in are ever processed.
function makeSyncMockDb({ uploadRows = [], downloadRows = [], filenames = {} } = {}) {
  let uploadServed = false;
  let downloadServed = false;
  const getFirstAsync = jest.fn(async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('SELECT filename FROM MediaAsset')) {
      const hash = params[0];
      return filenames[hash] ? { filename: filenames[hash] } : null;
    }
    if (typeof sql === 'string' && sql.includes('SELECT id FROM MediaAsset WHERE id = ? OR hash = ?')) {
      return { id: 1 };
    }
    if (typeof sql === 'string' && sql.includes('COUNT(*)') && sql.includes('uploaded = 1')) {
      return { count: uploadRows.length };
    }
    if (typeof sql === 'string' && sql.includes('COUNT(*)') && sql.includes('isLocal = 0') && sql.includes('clipEmbedding IS NULL')) {
      return { count: downloadRows.length };
    }
    return { count: 0 };
  });
  const getAllAsync = jest.fn(async (sql) => {
    if (typeof sql === 'string' && sql.includes('needsEmbedding')) {
      if (uploadServed) return [];
      uploadServed = true;
      return uploadRows;
    }
    if (typeof sql === 'string' && sql.includes('SELECT id, hash') && sql.includes('isLocal = 0') && sql.includes('LIMIT')) {
      if (downloadServed) return [];
      downloadServed = true;
      return downloadRows;
    }
    return [];
  });
  return {
    getFirstAsync,
    getAllAsync,
    runAsync: jest.fn().mockResolvedValue(),
  };
}

describe('AIService.processLocalEmbeddings (smoke)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AIService.isProcessing = false;
    AssetDBService.db = null;
    SecureStore.getItemAsync.mockResolvedValue(null);
  });

  test('is a no-op when already processing', async () => {
    AIService.isProcessing = true;
    await AIService.processLocalEmbeddings(10, true);
    // Guard clause returns before touching SecureStore at all.
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('skips when AI is disabled and force is false', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_ai_enabled' ? 'false' : null)
    );
    await AIService.processLocalEmbeddings(10, false);
    expect(AIService.isProcessing).toBe(false);
    // Never got far enough to touch the DB.
    expect(AssetDBService.db).toBeNull();
  });

  describe('AI models that are not downloaded yet', () => {
    const ModelAssetService = require('./../ModelAssetService').default;

    test('a forced run does not download over cellular when Wi-Fi Only is on', async () => {
      ModelAssetService.isReady.mockResolvedValueOnce(false);
      ModelAssetService.isDownloadAllowedNow.mockResolvedValueOnce(false);
      AssetDBService.db = makeEmptyDb();

      await AIService.processLocalEmbeddings(10, true);

      expect(ModelAssetService.ensureModels).not.toHaveBeenCalled();
      expect(AIService.isProcessing).toBe(false);
      expect(DeviceEventEmitter.emit).not.toHaveBeenCalledWith(
        'ai_processing_status', expect.objectContaining({ isProcessing: true })
      );
    });

    test('downloads them first when allowed, then indexes', async () => {
      ModelAssetService.isReady.mockResolvedValueOnce(false);
      AssetDBService.db = makeEmptyDb();

      await AIService.processLocalEmbeddings(10, true);

      expect(ModelAssetService.ensureModels).toHaveBeenCalledTimes(1);
      expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(
        'ai_processing_status', expect.objectContaining({ isProcessing: false })
      );
    });

    test('a failed download skips indexing instead of throwing', async () => {
      ModelAssetService.isReady.mockResolvedValueOnce(false);
      ModelAssetService.ensureModels.mockRejectedValueOnce(new Error('offline'));
      AssetDBService.db = makeEmptyDb();

      await expect(AIService.processLocalEmbeddings(10, true)).resolves.toBeUndefined();

      expect(AIService.isProcessing).toBe(false);
      expect(DeviceEventEmitter.emit).not.toHaveBeenCalledWith(
        'ai_processing_status', expect.objectContaining({ isProcessing: true })
      );
    });
  });

  test('completes cleanly and resets isProcessing when there is nothing pending', async () => {
    AssetDBService.db = makeEmptyDb();
    await AIService.processLocalEmbeddings(10, true);
    expect(AIService.isProcessing).toBe(false);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(
      'ai_processing_status',
      expect.objectContaining({ isProcessing: false })
    );
  });

  test('does not throw and still resets isProcessing when the DB query itself fails', async () => {
    AssetDBService.db = {
      getFirstAsync: jest.fn().mockRejectedValue(new Error('sqlite is locked')),
      getAllAsync: jest.fn(),
      runAsync: jest.fn(),
    };
    await expect(AIService.processLocalEmbeddings(10, true)).resolves.toBeUndefined();
    expect(AIService.isProcessing).toBe(false);
  });
});

describe('AIService.syncEmbeddings (smoke)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AIService.isSyncing = false;
    AIService._metadataWithoutIdServer = null;
    AssetDBService.db = null;
    SecureStore.getItemAsync.mockResolvedValue(null);
    AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
    AuthService.getToken.mockReturnValue('test-token');
  });

  test('is a no-op when already syncing', async () => {
    AIService.isSyncing = true;
    await AIService.syncEmbeddings(true);
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('skips when AI is disabled and force is false', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_ai_enabled' ? 'false' : null)
    );
    await AIService.syncEmbeddings(false);
    expect(AIService.isSyncing).toBe(false);
    expect(AssetDBService.db).toBeNull();
  });

  test('aborts cleanly when server url/token are missing', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    await AIService.syncEmbeddings(true);
    expect(AIService.isSyncing).toBe(false);
    expect(AssetDBService.db).toBeNull();
  });

  test('completes cleanly and resets isSyncing when there is nothing to upload or download', async () => {
    AssetDBService.db = makeEmptyDb();
    await AIService.syncEmbeddings(true);
    expect(AIService.isSyncing).toBe(false);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith(
      'ai_processing_status',
      expect.objectContaining({ isProcessing: false })
    );
  });

  test('batches multiple assets into a single upload POST instead of one request each', async () => {
    const uploadRows = [
      { id: 'h1', hash: 'h1', clipEmbedding: 'EMB1', phash: 'PH1', needsEmbedding: 1, needsPHash: 1 },
      { id: 'h2', hash: 'h2', clipEmbedding: 'EMB2', phash: 'PH2', needsEmbedding: 1, needsPHash: 1 },
      { id: 'h3', hash: 'h3', clipEmbedding: 'EMB3', phash: 'PH3', needsEmbedding: 1, needsPHash: 0 },
    ];
    AssetDBService.db = makeSyncMockDb({
      uploadRows,
      filenames: { h1: '101.jpg', h2: '102.jpg', h3: '103.jpg' },
    });
    axios.post.mockResolvedValue({ data: {} });

    await AIService.syncEmbeddings(true);

    const uploadCalls = axios.post.mock.calls.filter(([callUrl]) => callUrl.includes('/assets/metadata?force=1'));
    expect(uploadCalls).toHaveLength(1);
    const [, body] = uploadCalls[0];
    // h1 + h2 contribute embedding+phash (2 items each), h3 contributes embedding only -> 5 items total
    expect(body).toHaveLength(5);
    expect(body.every((item) => item.Category === 'similarity')).toBe(true);

    expect(AssetDBService.ensureRemoteMirrorRowsBatch).toHaveBeenCalledTimes(1);
    expect(AssetDBService.ensureRemoteMirrorRowsBatch).toHaveBeenCalledWith(['h1', 'h2', 'h3']);

    // Save-back is batched (one call covering all 3 assets), and scoped to isLocal=0 (the
    // remote mirror row) so it can't hit the isLocal=1 local row sharing the same hash --
    // see repairClipVersionResetBug() for the historical bug this scoping prevents.
    expect(AssetDBService.saveAssetEmbeddingsBatch).toHaveBeenCalledTimes(1);
    expect(AssetDBService.saveAssetEmbeddingsBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        { idOrHash: 'h1', embedding: 'EMB1', version: 0 },
        { idOrHash: 'h2', embedding: 'EMB2', version: 0 },
        { idOrHash: 'h3', embedding: 'EMB3', version: 0 },
      ]),
      0
    );
    expect(AssetDBService.saveAssetPHashesBatch).toHaveBeenCalledTimes(1);
    expect(AssetDBService.saveAssetPHashesBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        { idOrHash: 'h1', phash: 'PH1' },
        { idOrHash: 'h2', phash: 'PH2' },
      ]),
      0
    );

    // Progress events fire once per asset even though the HTTP call is once per batch.
    const progressCurrents = DeviceEventEmitter.emit.mock.calls
      .filter(([evt, status]) => evt === 'ai_processing_status' && status.message?.startsWith('Uploading photo features'))
      .map(([, status]) => status.current);
    expect(progressCurrents).toEqual([1, 2, 3]);
  });

  test('leaves rows pending (no DB writes) when the batched upload POST fails', async () => {
    const uploadRows = [
      { id: 'h1', hash: 'h1', clipEmbedding: 'EMB1', phash: 'PH1', needsEmbedding: 1, needsPHash: 1 },
    ];
    AssetDBService.db = makeSyncMockDb({ uploadRows, filenames: { h1: '101.jpg' } });
    axios.post.mockRejectedValue(new Error('timeout'));

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();
    expect(AIService.isSyncing).toBe(false);
    expect(AssetDBService.ensureRemoteMirrorRowsBatch).not.toHaveBeenCalled();
  });

  test('downloads a batch via /assets/metadata/byid and fills gaps for hashes missing from the response', async () => {
    const downloadRows = [
      { id: 'h1', hash: 'h1' },
      { id: 'h2', hash: 'h2' },
    ];
    AssetDBService.db = makeSyncMockDb({
      downloadRows,
      filenames: { h1: '201.jpg', h2: '202.jpg' },
    });
    axios.post.mockImplementation((callUrl) => {
      if (callUrl.includes('/assets/metadata/byid')) {
        // Only h1 comes back -- h2 is a server-side skip (stale/deleted id).
        return Promise.resolve({
          data: [{ Hash: 'h1', Metadatas: [{ Name: 'shared.phash.fingerprint', Value: 'PH1' }] }],
        });
      }
      return Promise.resolve({ data: {} });
    });

    await AIService.syncEmbeddings(true);

    const downloadCalls = axios.post.mock.calls.filter(([callUrl]) => callUrl.includes('/assets/metadata/byid'));
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0][1]).toEqual([201, 202]);

    expect(AssetDBService.saveAssetPHashesBatch).toHaveBeenCalledTimes(1);
    const pHashUpdates = AssetDBService.saveAssetPHashesBatch.mock.calls[0][0];
    expect(pHashUpdates).toEqual(
      expect.arrayContaining([
        { idOrHash: 'h1', phash: 'PH1' },
        { idOrHash: 'h2', phash: 'none' }, // gap-filled, not left un-processed
      ])
    );
  });

  test('stops instead of looping forever when a download batch has no resolvable server IDs', async () => {
    const downloadRows = [{ id: 'h1', hash: 'h1' }];
    AssetDBService.db = makeSyncMockDb({ downloadRows, filenames: {} }); // no filename -> falls back to network
    axios.get.mockRejectedValue(new Error('not found')); // network fallback also fails -> id stays unresolved
    axios.post.mockResolvedValue({ data: {} });

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();
    expect(AIService.isSyncing).toBe(false);
    expect(axios.post.mock.calls.some(([callUrl]) => callUrl.includes('/assets/metadata/byid'))).toBe(false);
  });
});

// Rows here stay pending no matter what (as they do in SQLite when an asset has no server ID
// yet or a request fails), and pages honor the `id > ?` cursor and LIMIT. A loop that re-reads
// its own unprocessed rows trips the call cap instead of hanging the test.
function makePersistentPendingDb({ uploadRows = [], downloadRows = [], remoteIndexRows = [] } = {}) {
  let calls = 0;
  const page = (rows, sql, params) => {
    const limit = Number(/LIMIT (\d+)/.exec(sql)[1]);
    const after = params?.[0] ?? '';
    return rows.filter((r) => r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
  };
  return {
    getFirstAsync: jest.fn(async (sql) => {
      if (sql.includes('COUNT(*)') && sql.includes('uploaded = 1')) return { count: uploadRows.length };
      return { count: 0 };
    }),
    getAllAsync: jest.fn(async (sql, params) => {
      if (++calls > 100) throw new Error('runaway loop: pending rows re-read');
      if (sql.includes('needsEmbedding')) return page(uploadRows, sql, params);
      if (sql.includes('faceRecVersion')) return page(remoteIndexRows, sql, params);
      if (sql.includes('isLocal = 0') && sql.includes('clipEmbedding IS NULL')) return page(downloadRows, sql, params);
      return [];
    }),
    runAsync: jest.fn().mockResolvedValue(),
  };
}

describe('AIService.syncEmbeddings with rows that stay pending', () => {
  const FileSystem = require('expo-file-system/legacy');
  const ids = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);

  beforeEach(() => {
    jest.clearAllMocks();
    AIService.isSyncing = false;
    AIService._metadataWithoutIdServer = null;
    SecureStore.getItemAsync.mockResolvedValue(null);
    AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
    AuthService.getToken.mockReturnValue('test-token');
  });

  const metadataLookups = () =>
    axios.get.mock.calls.filter(([u]) => u.includes('/asset/metadata/')).map(([u]) => u);

  test('uploads: assets without a server ID are visited once per pass, past the first batch', async () => {
    // More than one batch (20), none resolvable: no remote mirror row and the server's
    // metadata reply has no ID -- a fresh install right after its first backup.
    const uploadRows = ids(25, 'u').map((id) => ({ id, hash: id, clipEmbedding: 'E', phash: 'P', needsEmbedding: 1, needsPHash: 1 }));
    AssetDBService.db = makePersistentPendingDb({ uploadRows });
    axios.get.mockResolvedValue({ data: { Name: '1.jpg', Hash: 'x' } });

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();

    // The first reply shows this server leaves the ID out (a Hash, no Id), so the
    // remaining 24 rows skip the lookup instead of each paying a request for nothing.
    expect(metadataLookups()).toEqual(['http://localhost:8000/asset/metadata/u000']);
    // Every row is still walked exactly once -- the pass doesn't stall on the first batch.
    const progress = DeviceEventEmitter.emit.mock.calls
      .filter(([evt, s]) => evt === 'ai_processing_status' && s.message?.startsWith('Uploading photo features'))
      .map(([, s]) => s.current);
    expect(Math.max(...progress)).toBe(25);
  });

  test('uploads: a server that does answer with IDs is asked for every unresolved hash', async () => {
    const uploadRows = ids(3, 'u').map((id) => ({ id, hash: id, clipEmbedding: 'E', phash: 'P', needsEmbedding: 1, needsPHash: 1 }));
    AssetDBService.db = makePersistentPendingDb({ uploadRows });
    axios.get.mockResolvedValue({ data: { Name: '1.jpg', Hash: 'x', Id: 7 } });
    axios.post.mockResolvedValue({ data: {} });

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();

    // The skip is only for servers that reply without an ID; a working fallback
    // must not be latched off by it.
    expect(metadataLookups().map((u) => u.split('/').pop())).toEqual(['u000', 'u001', 'u002']);
    expect(AIService._metadataWithoutIdServer).toBeNull();
  });

  test('uploads: the skip is per server -- pointing at another one resumes lookups', async () => {
    const rows = () => ids(2, 'u').map((id) => ({ id, hash: id, clipEmbedding: 'E', phash: 'P', needsEmbedding: 1, needsPHash: 1 }));
    axios.get.mockResolvedValue({ data: { Name: '1.jpg', Hash: 'x' } });

    AssetDBService.db = makePersistentPendingDb({ uploadRows: rows() });
    await AIService.syncEmbeddings(true);
    expect(metadataLookups()).toHaveLength(1);

    // Same app, different box (a second Lomorage server, or one that got upgraded).
    AuthService.getServerUrl.mockReturnValue('http://other-server:8000');
    AIService.isSyncing = false;
    AssetDBService.db = makePersistentPendingDb({ uploadRows: rows() });
    await AIService.syncEmbeddings(true);

    expect(metadataLookups()).toEqual([
      'http://localhost:8000/asset/metadata/u000',
      'http://other-server:8000/asset/metadata/u000',
    ]);
  });

  test('uploads: a failing POST is sent once per batch, not retried in a loop', async () => {
    const uploadRows = ids(3, 'u').map((id, i) => ({ id, hash: id, clipEmbedding: 'E', phash: 'P', needsEmbedding: 1, needsPHash: 0, filename: `${i + 1}.jpg` }));
    AssetDBService.db = makePersistentPendingDb({ uploadRows });
    AssetDBService.db.getFirstAsync.mockImplementation(async (sql) =>
      sql.includes('SELECT filename') ? { filename: '7.jpg' } : { count: uploadRows.length });
    axios.post.mockRejectedValue(new Error('500'));

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();

    expect(axios.post.mock.calls.filter(([u]) => u.includes('/assets/metadata?force=1'))).toHaveLength(1);
  });

  test('downloads: a failing /assets/metadata/byid is sent once per batch', async () => {
    const downloadRows = ids(3, 'd').map((id) => ({ id, hash: id }));
    AssetDBService.db = makePersistentPendingDb({ downloadRows });
    AssetDBService.db.getFirstAsync.mockImplementation(async (sql) =>
      sql.includes('SELECT filename') ? { filename: '7.jpg' } : { count: 0 });
    axios.post.mockRejectedValue(new Error('500'));

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();

    expect(axios.post.mock.calls.filter(([u]) => u.includes('/assets/metadata/byid'))).toHaveLength(1);
  });

  test('remote photos: a preview that fails to download is fetched once per pass', async () => {
    // A HEIC the server can't make previews for; its embedding came from the local copy,
    // only face detection is pending.
    const remoteIndexRows = [{ id: 'r1', hash: 'r1', clipEmbedding: 'E', faceRecVersion: null }];
    AssetDBService.db = makePersistentPendingDb({ remoteIndexRows });
    FileSystem.downloadAsync.mockResolvedValue({ status: 500 });

    await expect(AIService.syncEmbeddings(true)).resolves.toBeUndefined();

    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(1);
  });
});
