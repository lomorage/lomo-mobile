const crypto = require('crypto');

const CryptoDigestAlgorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512', MD5: 'MD5' };
const CryptoEncoding = { HEX: 'hex', BASE64: 'base64' };

const nodeAlgorithm = (alg) => alg.replace('-', '').toLowerCase();

module.exports = {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  randomUUID: () => crypto.randomUUID(),
  getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  digestStringAsync: async (alg, data, { encoding = CryptoEncoding.HEX } = {}) =>
    crypto.createHash(nodeAlgorithm(alg)).update(data, 'utf8').digest(encoding),
  digest: async (alg, data) => {
    const buf = crypto.createHash(nodeAlgorithm(alg)).update(Buffer.from(data.buffer ?? data)).digest();
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  },
};
