// expo-file-system/legacy on top of node:fs, with uploads/downloads over the
// real network via fetch -- the upload path is exactly what we want to exercise
// against lomod.
const fs = require('fs');
const path = require('path');
const sandbox = require('./sandbox');

const toPath = sandbox.toPath;

const EncodingType = { UTF8: 'utf8', Base64: 'base64' };
const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 };
const FileSystemSessionType = { BACKGROUND: 0, FOREGROUND: 1 };

const documentDirectory = sandbox.dirUri('documents');
const cacheDirectory = sandbox.dirUri('cache');

async function getInfoAsync(uri) {
  try {
    const st = await fs.promises.stat(toPath(uri));
    return {
      exists: true,
      isDirectory: st.isDirectory(),
      size: st.size,
      modificationTime: st.mtimeMs / 1000,
      uri,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, isDirectory: false, uri };
    throw e;
  }
}

async function makeDirectoryAsync(uri, { intermediates = false } = {}) {
  await fs.promises.mkdir(toPath(uri), { recursive: intermediates });
}

async function readAsStringAsync(uri, { encoding = EncodingType.UTF8, position, length } = {}) {
  const p = toPath(uri);
  if (position === undefined && length === undefined) {
    return (await fs.promises.readFile(p)).toString(encoding);
  }
  const fh = await fs.promises.open(p, 'r');
  try {
    const size = length ?? (await fh.stat()).size - (position ?? 0);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, position ?? 0);
    return buf.subarray(0, bytesRead).toString(encoding);
  } finally {
    await fh.close();
  }
}

async function writeAsStringAsync(uri, contents, { encoding = EncodingType.UTF8 } = {}) {
  const p = toPath(uri);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, Buffer.from(contents, encoding));
}

async function deleteAsync(uri, { idempotent = false } = {}) {
  const p = toPath(uri);
  if (!idempotent && !fs.existsSync(p)) {
    throw new Error(`File '${uri}' could not be deleted because it could not be found`);
  }
  await fs.promises.rm(p, { recursive: true, force: true });
}

async function copyAsync({ from, to }) {
  await fs.promises.cp(toPath(from), toPath(to), { recursive: true });
}

async function moveAsync({ from, to }) {
  await fs.promises.rename(toPath(from), toPath(to));
}

async function downloadAsync(url, fileUri, { headers } = {}) {
  const res = await fetch(url, { headers });
  const body = Buffer.from(await res.arrayBuffer());
  const p = toPath(fileUri);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, body);
  return { uri: fileUri, status: res.status, headers: Object.fromEntries(res.headers) };
}

function createUploadTask(url, fileUri, options = {}, onProgress) {
  const controller = new AbortController();
  return {
    async uploadAsync() {
      if ((options.uploadType ?? FileSystemUploadType.BINARY_CONTENT) !== FileSystemUploadType.BINARY_CONTENT) {
        throw new Error('integration shim only supports BINARY_CONTENT uploads');
      }
      const body = await fs.promises.readFile(toPath(fileUri));
      const res = await fetch(url, {
        method: options.httpMethod || 'POST',
        headers: options.headers,
        body,
        signal: controller.signal,
      });
      if (onProgress) {
        onProgress({ totalBytesSent: body.length, totalBytesExpectedToSend: body.length });
      }
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    },
    async cancelAsync() {
      controller.abort();
    },
  };
}

module.exports = {
  EncodingType,
  FileSystemSessionType,
  FileSystemUploadType,
  cacheDirectory,
  copyAsync,
  createUploadTask,
  deleteAsync,
  documentDirectory,
  downloadAsync,
  getInfoAsync,
  makeDirectoryAsync,
  moveAsync,
  readAsStringAsync,
  writeAsStringAsync,
};
