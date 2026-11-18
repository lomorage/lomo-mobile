// Non-fatal reports to Crashlytics. Never throws: a report must not turn a
// handled failure into a new one, and Jest or a build without Firebase has no
// native module. Callers pass only coarse facts (sizes, kinds), never paths,
// file names or ids.

const MAX_REPORTS_PER_SESSION = 10;
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

// A gallery full of one bad kind of picture would otherwise send one report
// per photo. The first few say everything.
export function reportNonFatal(error, name, context = {}) {
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return false;
  const api = loadCrashlytics();
  if (!api) return false;
  try {
    const message = error?.message || String(error);
    const report = new Error(message);
    report.name = name;
    if (error?.stack) report.stack = error.stack;
    api.mod.log(api.instance, `${name} ${JSON.stringify(context)}`);
    api.mod.recordError(api.instance, report, name);
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
