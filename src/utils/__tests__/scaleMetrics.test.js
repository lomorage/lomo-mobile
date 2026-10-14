jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key) => { store.delete(key); }),
  };
});

const SecureStore = require('expo-secure-store');
import {
  formatMetric, logSinceAppStartOnce, logSincePairedOnce, markAppStart, markPaired,
} from '../scaleMetrics';

let logs;
beforeEach(() => {
  SecureStore.__store.clear();
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
});
afterEach(() => console.log.mockRestore());

test('formats one grep-able line and skips empty fields', () => {
  expect(formatMetric('scan', 1234.4, { assets: 1000, toUpload: 0, note: undefined }))
    .toBe('[ScaleMetric] name=scan ms=1234 assets=1000 toUpload=0');
});

test('per-launch metrics log once, measured from app start', () => {
  markAppStart(1000);
  logSinceAppStartOnce('time_to_view', { assets: 5 }, 3500);
  logSinceAppStartOnce('time_to_view', { assets: 6 }, 9000);
  expect(logs).toEqual(['[ScaleMetric] name=time_to_view ms=2500 assets=5']);

  markAppStart(20000);
  logSinceAppStartOnce('time_to_view', {}, 20100);
  expect(logs[1]).toBe('[ScaleMetric] name=time_to_view ms=100');
});

test('journey metrics are measured from pairing, survive restarts, and log once per pairing', async () => {
  await logSincePairedOnce('time_to_first_backup', {}, 5000);
  expect(logs).toEqual([]); // not paired yet

  await markPaired('nas|alice', 1000);
  await logSincePairedOnce('time_to_first_backup', { photos: 3 }, 61000);
  await logSincePairedOnce('time_to_first_backup', { photos: 4 }, 99000);
  expect(logs).toEqual(['[ScaleMetric] name=time_to_first_backup ms=60000 photos=3']);

  await markPaired('nas|alice', 150000); // logging in again to the same account: no restart
  await logSincePairedOnce('time_to_first_backup', {}, 160000);
  expect(logs).toHaveLength(1);

  await markPaired('pc|alice', 200000); // a different computer restarts the journey
  await logSincePairedOnce('time_to_first_backup', {}, 230000);
  expect(logs[1]).toBe('[ScaleMetric] name=time_to_first_backup ms=30000');
});

test('markPaired tells whether this is a new pairing', async () => {
  await expect(markPaired('nas|alice', 1)).resolves.toBe(true);
  await expect(markPaired('nas|alice', 2)).resolves.toBe(false);
  await expect(markPaired('pc|alice', 3)).resolves.toBe(true);
});
