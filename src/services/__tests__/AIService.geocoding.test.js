// The background place-name pass (runBackgroundGeocoding), against a fake database.
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
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  reverseGeocodeAsync: jest.fn(),
}));
jest.mock('./../AssetDBService', () => ({
  db: null,
  saveAssetOCR: jest.fn(),
  saveAssetMetadata: jest.fn(),
  markLocationChecked: jest.fn(),
  saveAssetLocation: jest.fn(),
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
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  encodeFaceEmbeddingAsync: jest.fn(),
  encodeImageEmbeddingAsync: jest.fn(),
  encodeTextEmbeddingAsync: jest.fn(),
  prepareAnalysisImageAsync: jest.fn(),
  generatePHashAsync: jest.fn(),
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

// The native RNMLKitFaceDetection module, as expo-modules-core returns it.
const mockNativeFace = {
  initialize: jest.fn(),
  detectFaces: jest.fn(),
};
jest.mock('expo-modules-core', () => ({
  requireNativeModule: jest.fn((name) => (name === 'RNMLKitFaceDetection' ? mockNativeFace : {})),
}));
jest.mock('@react-native-firebase/crashlytics', () => {
  const instance = { tag: 'crashlytics' };
  return {
    getCrashlytics: jest.fn(() => instance),
    log: jest.fn(),
    recordError: jest.fn(),
  };
});

const AssetDBService = require('./../AssetDBService');
const Location = require('expo-location');
import AIService from '../AIService';

// pendingBatches: what each "SELECT id, latitude, longitude ... locationChecked = 0" returns, in turn.
function fakeDb(pendingBatches) {
  const batches = [...pendingBatches];
  return {
    runAsync: jest.fn(async () => ({ changes: 0 })),
    getAllAsync: jest.fn(async (sql) => {
      if (sql.includes('locationChecked = 0')) return batches.shift() || [];
      return []; // the warm-up cache of already named places
    }),
  };
}

// A database holding `rows` still to be named, honouring the NOT IN / IN the pass adds.
// `named` collects rows the pass saved, which then leave the queue.
function tableDb(rows) {
  const named = new Set();
  return {
    named,
    runAsync: jest.fn(async () => ({ changes: 0 })),
    getAllAsync: jest.fn(async (sql, params = []) => {
      if (!sql.includes('locationChecked = 0')) return [];
      let out = rows.filter(r => !named.has(r.id));
      if (sql.includes('NOT IN')) out = out.filter(r => !params.includes(r.id));
      else if (sql.includes(' IN (')) out = out.filter(r => params.includes(r.id));
      return out.slice(0, 200);
    }),
  };
}

const row = (id, latitude, longitude) => ({ id, latitude, longitude });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Session state on the singleton.
  AIService._geocodeFailures = new Map();
  AIService._geocodeWorked = false;
  Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
});
afterEach(() => {
  jest.useRealTimers();
});

async function runToEnd(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 500 && !done; i++) {
    await jest.advanceTimersByTimeAsync(5000);
  }
  return promise;
}

test('only rows known to have no coordinates are marked checked, not ones still waiting for theirs', async () => {
  const db = fakeDb([]);
  AssetDBService.db = db;
  await runToEnd(AIService.runBackgroundGeocoding());
  const marks = db.runAsync.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('SET locationChecked = 1'));
  expect(marks).toEqual([expect.stringContaining('hasGeo = -1')]);
  expect(marks[0]).not.toMatch(/hasGeo = 0/);
});

test('keeps going past one batch until nothing is left', async () => {
  const first = Array.from({ length: 200 }, (_, i) => row(`a${i}`, 46.77, 23.6)); // all one place
  const db = fakeDb([first, [row('b1', 44.43, 26.1)]]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync.mockResolvedValue([{ city: 'Cluj-Napoca', region: 'Cluj', country: 'Romania' }]);

  await runToEnd(AIService.runBackgroundGeocoding());

  expect(AssetDBService.saveAssetLocation).toHaveBeenCalledTimes(201);
  expect(AssetDBService.saveAssetLocation).toHaveBeenCalledWith('b1', expect.anything(), expect.anything());
});

test('a lookup service that keeps failing stops the run and marks nothing', async () => {
  const db = fakeDb([[row('a', 46.77, 23.6), row('b', 44.43, 26.1), row('c', 48.85, 2.35)]]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync.mockRejectedValue(new Error('Service not Available'));

  await runToEnd(AIService.runBackgroundGeocoding());

  expect(Location.reverseGeocodeAsync).toHaveBeenCalledTimes(2); // two in a row, then stop
  expect(AssetDBService.markLocationChecked).not.toHaveBeenCalled();
});

test('an outage partway through a batch marks nothing either', async () => {
  const db = fakeDb([[row('a', 46.77, 23.6), row('b', 44.43, 26.1), row('c', 48.85, 2.35), row('d', 40.4, -3.7)]]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync
    .mockResolvedValueOnce([{ city: 'Cluj-Napoca' }])
    .mockRejectedValue(new Error('offline'));

  await runToEnd(AIService.runBackgroundGeocoding());

  expect(AssetDBService.markLocationChecked).not.toHaveBeenCalled();
  expect(Location.reverseGeocodeAsync).toHaveBeenCalledTimes(3);
});

test('one failing coordinate between working lookups is skipped, not marked, the first time', async () => {
  const db = fakeDb([[row('a', 46.77, 23.6), row('bad', 10, 10), row('c', 44.43, 26.1)]]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync
    .mockResolvedValueOnce([{ city: 'Cluj-Napoca', country: 'Romania' }])
    .mockRejectedValueOnce(new Error('bad coordinate'))
    .mockResolvedValueOnce([{ city: 'Bucharest', country: 'Romania' }]);

  await runToEnd(AIService.runBackgroundGeocoding());

  expect(AssetDBService.markLocationChecked).not.toHaveBeenCalled();
  expect(AssetDBService.saveAssetLocation).toHaveBeenCalledWith('c', expect.objectContaining({ city: 'Bucharest' }), expect.anything());
});

test('does not start while AI processing runs, and remembers to start once it ends', async () => {
  AssetDBService.db = fakeDb([[row('a', 46.77, 23.6)]]);
  AIService.isProcessing = true;
  try {
    await runToEnd(AIService.runBackgroundGeocoding());
  } finally {
    AIService.isProcessing = false;
  }
  expect(Location.reverseGeocodeAsync).not.toHaveBeenCalled();
  expect(AIService._geocodingDeferred).toBe(true);
  AIService._geocodingDeferred = false;
});

test('a call during a run joins it instead of starting a second one', async () => {
  const db = fakeDb([[row('a', 46.77, 23.6)]]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync.mockResolvedValue([{ city: 'Cluj-Napoca' }]);

  const first = AIService.runBackgroundGeocoding();
  const second = AIService.runBackgroundGeocoding();
  expect(second).toBe(first);
  await runToEnd(first);
  expect(Location.reverseGeocodeAsync).toHaveBeenCalledTimes(1);
});

test('does nothing without location permission', async () => {
  Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
  const db = fakeDb([[row('a', 46.77, 23.6)]]);
  AssetDBService.db = db;
  await runToEnd(AIService.runBackgroundGeocoding());
  expect(Location.reverseGeocodeAsync).not.toHaveBeenCalled();
});

test('a coordinate the service always rejects, while others work, is marked after a few runs', async () => {
  const db = tableDb([row('sea', 10, 10), row('ok', 46.77, 23.6)]);
  AssetDBService.db = db;
  AssetDBService.saveAssetLocation.mockImplementation(async (id) => { db.named.add(id); });
  Location.reverseGeocodeAsync.mockImplementation(async ({ latitude }) => {
    if (latitude === 10) throw new Error('no result');
    return [{ city: 'Somewhere' }];
  });
  for (let i = 0; i < 4; i++) await runToEnd(AIService.runBackgroundGeocoding());
  expect(AssetDBService.markLocationChecked).not.toHaveBeenCalled();
  await runToEnd(AIService.runBackgroundGeocoding());
  expect(AssetDBService.markLocationChecked).toHaveBeenCalledWith('sea');
});

test('two failing coordinates in a row go to the back of the queue instead of blocking it', async () => {
  const db = tableDb([row('sea1', 10, 10), row('sea2', 11, 11), row('a', 46.77, 23.6), row('b', 44.43, 26.1)]);
  AssetDBService.db = db;
  AssetDBService.saveAssetLocation.mockImplementation(async (id) => { db.named.add(id); });
  Location.reverseGeocodeAsync.mockImplementation(async ({ latitude }) => {
    if (latitude < 12) throw new Error('no result');
    return [{ city: 'Somewhere' }];
  });
  await runToEnd(AIService.runBackgroundGeocoding()); // stops after sea1, sea2
  await runToEnd(AIService.runBackgroundGeocoding()); // the rest first
  expect([...db.named].sort()).toEqual(['a', 'b']);
});

test('while offline nothing is ever marked, however many runs', async () => {
  const db = tableDb([row('a', 46.77, 23.6), row('b', 44.43, 26.1)]);
  AssetDBService.db = db;
  Location.reverseGeocodeAsync.mockRejectedValue(new Error('offline'));
  for (let i = 0; i < 8; i++) await runToEnd(AIService.runBackgroundGeocoding());
  expect(AssetDBService.markLocationChecked).not.toHaveBeenCalled();
});

test('stops instead of spinning when a full batch changed nothing', async () => {
  const stuck = Array.from({ length: 200 }, (_, i) => row(`s${i}`, 46.77, 23.6));
  const db = { runAsync: jest.fn(async () => ({ changes: 0 })), getAllAsync: jest.fn(async (sql) => (sql.includes('locationChecked = 0') ? stuck : [])) };
  AssetDBService.db = db;
  Location.reverseGeocodeAsync.mockResolvedValue([{ city: 'Cluj-Napoca' }]); // saves "fail": rows come back
  await runToEnd(AIService.runBackgroundGeocoding());
  const pendingQueries = db.getAllAsync.mock.calls.filter(([sql]) => sql.includes('locationChecked = 0'));
  expect(pendingQueries).toHaveLength(2);
});

test('a call during the last batch makes the run look once more', async () => {
  const batches = [[row('a', 46.77, 23.6)], [row('late', 44.43, 26.1)]];
  AssetDBService.db = { runAsync: jest.fn(async () => ({ changes: 0 })), getAllAsync: jest.fn(async (sql) => (sql.includes('locationChecked = 0') ? (batches.shift() || []) : [])) };
  Location.reverseGeocodeAsync.mockResolvedValue([{ city: 'X' }]);
  const run = AIService.runBackgroundGeocoding();
  AIService.runBackgroundGeocoding(); // new coordinates arrived meanwhile
  await runToEnd(run);
  expect(AssetDBService.saveAssetLocation).toHaveBeenCalledWith('late', expect.anything(), expect.anything());
});
