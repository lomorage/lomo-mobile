// Node versions of the native ExpoLomoHasher calls the backup path uses.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { toPath } = require('./sandbox');

async function hashFileAsync(uri) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(toPath(uri))) hash.update(chunk);
  return hash.digest('hex');
}

async function sliceFileAsync(sourceUri, destUri, offset) {
  const dest = toPath(destUri);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const data = await fs.promises.readFile(toPath(sourceUri));
  await fs.promises.writeFile(dest, data.subarray(offset));
  return true;
}

async function sliceFileRangeAsync(sourceUri, destUri, offset, length) {
  const dest = toPath(destUri);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const fh = await fs.promises.open(toPath(sourceUri), 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    await fs.promises.writeFile(dest, buf.subarray(0, bytesRead));
    return bytesRead;
  } finally {
    await fh.close();
  }
}

const notOnNode = (name) => async () => {
  throw new Error(`ExpoLomoHasher.${name} is not available in integration tests`);
};

module.exports = {
  hashFileAsync,
  sliceFileAsync,
  sliceFileRangeAsync,
  isLivePhotoAsync: async () => false,
  prepareLivePhotoBackupAsync: async () => null,
  extractVideoFromZipAsync: notOnNode('extractVideoFromZipAsync'),
  getLocalLivePhotoVideoUriAsync: notOnNode('getLocalLivePhotoVideoUriAsync'),
  encodeImageEmbeddingAsync: notOnNode('encodeImageEmbeddingAsync'),
  encodeTextEmbeddingAsync: notOnNode('encodeTextEmbeddingAsync'),
  encodeFaceEmbeddingAsync: notOnNode('encodeFaceEmbeddingAsync'),
  generatePHashAsync: notOnNode('generatePHashAsync'),
};
