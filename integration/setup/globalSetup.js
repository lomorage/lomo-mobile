// Fail fast with a useful message instead of 20 identical spawn errors.
const fs = require('fs');

module.exports = async () => {
  const bin = process.env.LOMOD_BIN;
  if (!bin) {
    throw new Error(
      'LOMOD_BIN is not set. Point it at a lomod binary, e.g.\n' +
        '  LOMOD_BIN=/path/to/lomod npm run test:integration\n' +
        'See integration/README.md.',
    );
  }
  if (!fs.existsSync(bin)) throw new Error(`LOMOD_BIN=${bin} does not exist`);
};
