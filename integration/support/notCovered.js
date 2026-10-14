// A test that can't exercise its main path against this lomod (e.g. a feature the CI image doesn't
// have yet) records it here instead of only logging: quietConsole hides console output, so a
// warning alone would make a skipped path look like a pass. globalTeardown prints the list.
const fs = require('fs');
const path = require('path');
const { ARTIFACTS_DIR } = require('./lomod');

const NOT_COVERED_FILE = path.join(ARTIFACTS_DIR, 'not-covered.txt');

function notCovered(what) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.appendFileSync(NOT_COVERED_FILE, `${expect.getState().currentTestName}: ${what}\n`);
}

module.exports = { notCovered, NOT_COVERED_FILE };
