// react-native-argon2's API backed by hash-wasm, producing the same PHC-encoded
// string the app sends to lomod (memory is in KiB in both libraries).
const { argon2d, argon2i, argon2id } = require('hash-wasm');

const modes = { argon2d, argon2i, argon2id };

module.exports = async function argon2(password, salt, config = {}) {
  const { mode = 'argon2id', hashLength = 32, iterations = 2, memory = 32 * 1024, parallelism = 1 } = config;
  const params = { password, salt, hashLength, iterations, memorySize: memory, parallelism };
  const hash = modes[mode];
  return {
    rawHash: await hash({ ...params, outputType: 'hex' }),
    encodedHash: await hash({ ...params, outputType: 'encoded' }),
  };
};
