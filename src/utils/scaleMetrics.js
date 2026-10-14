import * as SecureStore from 'expo-secure-store';

// Timings for real-device scale tests (100 / 1K / 10K / 50K photos). Each one is a single
// grep-able line:
//   adb logcat | grep ScaleMetric
//   [ScaleMetric] name=time_to_first_backup ms=48210 photos=1000
// Per-launch timings start at markAppStart(); journey timings (pairing -> first backup ->
// everything backed up -> confirmed safe) start at markPaired(), survive app restarts and
// are logged once per pairing.

const PAIRED_AT_KEY = 'lomorage_metric_paired_at';
const PAIRING_ID_KEY = 'lomorage_metric_pairing_id';
const LOGGED_KEY_PREFIX = 'lomorage_metric_logged_';
const JOURNEY_METRICS = ['time_to_first_backup', 'time_to_full_backup', 'time_to_safe'];

let appStartedAt = null;
const loggedThisLaunch = new Set();

export function formatMetric(name, ms, extra = {}) {
  const fields = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return ['[ScaleMetric]', `name=${name}`, `ms=${Math.round(ms)}`, ...fields].join(' ');
}

export function logMetric(name, ms, extra) {
  console.log(formatMetric(name, ms, extra));
}

export function markAppStart(now = Date.now()) {
  appStartedAt = now;
  loggedThisLaunch.clear();
}

// Logs time since app start for `name`, once per launch.
export function logSinceAppStartOnce(name, extra, now = Date.now()) {
  if (appStartedAt === null || loggedThisLaunch.has(name)) return;
  loggedThisLaunch.add(name);
  logMetric(name, now - appStartedAt, extra);
}

// Pairing with a server/account restarts the journey timings. Logging in again to the same
// one (e.g. after the session expired) does not. Returns true for a new pairing.
export async function markPaired(pairingId, now = Date.now()) {
  try {
    if ((await SecureStore.getItemAsync(PAIRING_ID_KEY)) === pairingId) return false;
    await SecureStore.setItemAsync(PAIRING_ID_KEY, pairingId);
    await SecureStore.setItemAsync(PAIRED_AT_KEY, String(now));
    await Promise.all(JOURNEY_METRICS.map(name => SecureStore.deleteItemAsync(LOGGED_KEY_PREFIX + name)));
    return true;
  } catch (e) {
    console.warn('[scaleMetrics] markPaired failed:', e.message);
    return false;
  }
}

// Logs time since pairing for `name`, once per pairing.
export async function logSincePairedOnce(name, extra, now = Date.now()) {
  try {
    const [pairedAt, logged] = await Promise.all([
      SecureStore.getItemAsync(PAIRED_AT_KEY),
      SecureStore.getItemAsync(LOGGED_KEY_PREFIX + name),
    ]);
    if (!pairedAt || logged === 'true') return;
    await SecureStore.setItemAsync(LOGGED_KEY_PREFIX + name, 'true');
    logMetric(name, now - Number(pairedAt), extra);
  } catch (e) {
    console.warn(`[scaleMetrics] ${name} failed:`, e.message);
  }
}
