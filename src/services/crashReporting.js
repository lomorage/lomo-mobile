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

// Native messages carry the file they failed on, e.g. RNMLKitImage's
// "Could not load image from file:///storage/emulated/0/DCIM/...". Replace
// every URI and absolute path; keep the rest of the text. File names can hold
// spaces, so a match runs to the end of the line, a quote or bracket, or
// ": " / ", ". Taking too much is fine; leaving part of a name is not.
const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\n'")\]}]*?(?=$|[\n'")\]}]|:\s|,\s)/gim;
const PATH_PATTERN = /(^|[\s'"(=:])\/(?:storage|sdcard|data|mnt|var|private|Users|tmp|system)\/[^\n'")\]}]*?(?=$|[\n'")\]}]|:\s|,\s)/gim;

export function scrubMessage(text) {
  return String(text)
    .replace(URI_PATTERN, '<uri>')
    .replace(PATH_PATTERN, (_match, lead) => `${lead}<path>`);
}

// A gallery full of one bad kind of picture would otherwise send one report
// per photo. The first few say everything.
export function reportNonFatal(error, name, context = {}) {
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return false;
  const api = loadCrashlytics();
  if (!api) return false;
  try {
    // A fresh Error, not the original: the original's stack begins with the
    // unscrubbed message, and JS frames of a native rejection say nothing.
    const report = new Error(scrubMessage(error?.message || String(error)));
    report.name = name;
    api.mod.log(api.instance, scrubMessage(`${name} ${JSON.stringify(context)}`));
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
