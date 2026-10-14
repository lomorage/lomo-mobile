// Runs in Jest's parent process, outside quietConsole: list the paths tests couldn't exercise.
const fs = require('fs');
const { NOT_COVERED_FILE } = require('../support/notCovered');

module.exports = async () => {
  if (!fs.existsSync(NOT_COVERED_FILE)) return;
  const lines = fs.readFileSync(NOT_COVERED_FILE, 'utf8').trim();
  if (lines) console.log(`\nNot covered by this lomod (${process.env.LOMOD_BIN || 'LOMOD_BIN'}):\n${lines}\n`);
};
