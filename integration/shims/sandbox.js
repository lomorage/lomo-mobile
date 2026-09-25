// Per-test-file scratch directory standing in for the app's sandbox
// (documentDirectory / cacheDirectory / the SQLite dir / the camera roll).
// Jest gives every test file a fresh module registry, so each file gets its own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lomo-it-app-'));

function dir(name) {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Expo hands out directory URIs with a trailing slash and the services build
// paths by string concatenation, so keep that shape.
function dirUri(name) {
  return pathToFileURL(dir(name)).href + '/';
}

// Accepts what the services pass around: file:// URIs, and raw paths produced
// by `uri.replace('file://', '')` (which leaves "/C:/..." on Windows).
function toPath(uri) {
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  if (/^\/[A-Za-z]:[\\/]/.test(uri)) return uri.slice(1);
  return uri;
}

function cleanup() {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

module.exports = { root, dir, dirUri, toPath, cleanup };
