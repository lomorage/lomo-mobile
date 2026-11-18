// Non-fatal reports to Crashlytics. Never throws: a report must not turn a
// handled failure into a new one, and Jest or a build without Firebase has no
// native module.
//
// Nothing free-form is sent. Native error messages embed the file they failed
// on, and Android builds those uris as "file://" + path with nothing escaped,
// so a name like "Trip, Alice (2).jpg" survives any scrubbing pattern. The
// message is the report name plus a fixed category; fields pass a whitelist.

const MAX_REPORTS_PER_SESSION = 10;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
let reportsSent = 0;
let crashlyticsApi;

function loadCrashlytics() {
  if (crashlyticsApi === undefined) {
    try {
      const mod = require('@react-native-firebase/crashlytics');
      crashlyticsApi = { mod, instance: mod.getCrashlytics() };
    } catch (_e) {
      crashlyticsApi = null;
    }
  }
  return crashlyticsApi;
}

// Keeps finite numbers, booleans and short identifier-like strings under
// identifier-like keys. Drops everything else, including any string with a
// space, slash or comma.
export function safeFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [key, value] of Object.entries(fields)) {
    if (!TOKEN.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && TOKEN.test(value)) out[key] = value;
  }
  return out;
}

// A gallery full of one bad kind of picture would otherwise send one report
// per photo. The first few say everything.
export function reportNonFatal(name, category, fields = {}) {
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return false;
  const api = loadCrashlytics();
  if (!api) return false;
  try {
    const safeName = TOKEN.test(String(name)) ? String(name) : 'NonFatal';
    const safeCategory = TOKEN.test(String(category)) ? String(category) : 'other';
    const report = new Error(`${safeName}: ${safeCategory}`);
    report.name = safeName;
    api.mod.log(api.instance, `${safeName} ${JSON.stringify(safeFields(fields))}`);
    api.mod.recordError(api.instance, report, safeName);
    reportsSent += 1;
    return true;
  } catch (_e) {
    return false;
  }
}

export function _resetCrashReportingForTests() {
  reportsSent = 0;
  crashlyticsApi = undefined;
}
