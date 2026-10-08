import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import AuthService from '../../src/services/AuthService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer, waitFor } from '../support/harness';

const server = startTestServer('large-upload');

const KiB = 1024;
const MiB = 1024 * KiB;

// Stands in for Cloudflare in front of lomod: a request whose Content-Length is over the limit
// gets 413 straight away and never reaches lomod; anything else is passed through. Every
// request is recorded so tests can see how the app split its uploads.
function startLimitingProxy(target, limit) {
  const requests = [];
  const proxy = http.createServer((req, res) => {
    const length = Number(req.headers['content-length'] || 0);
    const entry = { method: req.method, path: req.url.split('?')[0], length };
    requests.push(entry);
    if (limit && length > limit) {
      entry.status = 413;
      req.resume();
      res.writeHead(413, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>413 Payload Too Large</h1></body></html>');
      return;
    }
    const upstream = http.request(`${target}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
      entry.status = up.statusCode;
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      entry.status = 502;
      res.writeHead(502);
      res.end(String(err));
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      const { port } = proxy.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        address: `127.0.0.1:${port}`,
        requests,
        uploads: () => requests.filter((r) => r.method === 'POST' || r.method === 'PATCH'),
        close: () => new Promise((r) => proxy.close(r)),
      });
    });
  });
}

// A real JPEG padded with random bytes (decoders ignore trailing data), so every file is unique
// and big enough to exceed the proxy limit.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lomo-large-'));
function bigPhoto(name, size) {
  const jpeg = fs.readFileSync(fixturePath('photo-2003-11-01.jpg'));
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, Buffer.concat([jpeg, crypto.randomBytes(size - jpeg.length)]));
  return file;
}

async function downloadedSha1(hash) {
  const res = await fetch(`${server.url}/asset/${hash}?orig=1&token=${AuthService.getToken()}`);
  expect(res.status).toBe(200);
  return crypto.createHash('sha1').update(Buffer.from(await res.arrayBuffer())).digest('hex');
}

describe('uploading files larger than a proxy allows', () => {
  let limited;
  let direct;

  beforeAll(async () => {
    limited = await startLimitingProxy(server.url, 1.5 * MiB);
    direct = await startLimitingProxy(server.url, 0); // no limit, like a LAN connection
    await registerUser(limited);
  });

  beforeEach(async () => {
    UploadService.chunkSize = 1 * MiB;
    UploadService.minChunkSize = 256 * KiB;
    UploadService.chunkedServers = {};
    limited.requests.length = 0;
    direct.requests.length = 0;
    await AuthService.updateServerUrl(limited.url);
  });

  afterAll(async () => {
    await limited.close();
    await direct.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('switches to pieces after a 413 and the server gets the exact file', async () => {
    const file = bigPhoto('big1.jpg', 3.5 * MiB);
    const hash = sha1(file);
    const progress = [];

    const result = await UploadService.uploadAsset(addToCameraRoll(file), (p) => progress.push(p.loaded));

    expect(result).toMatchObject({ success: true, hash, chunked: true });
    const uploads = limited.uploads();
    expect(uploads[0]).toMatchObject({ method: 'POST', length: fs.statSync(file).size, status: 413 });
    expect(uploads.slice(1).map((r) => [r.method, r.length])).toEqual([
      ['POST', 1 * MiB], ['PATCH', 1 * MiB], ['PATCH', 1 * MiB], ['PATCH', 0.5 * MiB],
    ]);
    expect(uploads.slice(1).every((r) => r.length <= 1.5 * MiB)).toBe(true);
    expect(progress[progress.length - 1]).toBe(fs.statSync(file).size);
    await expect(downloadedSha1(hash)).resolves.toBe(hash);
    await expect(AuthService.getServerUrl()).toBe(limited.url);
    await expect(UploadService.getChunkSize(limited.url)).resolves.toBe(1 * MiB);
  });

  it('remembers the limit: the next large file goes in pieces without another 413', async () => {
    await UploadService._rememberChunkSize(limited.url, 1 * MiB);
    const file = bigPhoto('big2.jpg', 2.2 * MiB);
    const hash = sha1(file);

    const result = await UploadService.uploadAsset(addToCameraRoll(file));

    expect(result).toMatchObject({ success: true, hash, chunked: true });
    expect(limited.uploads().some((r) => r.status === 413)).toBe(false);
    expect(limited.uploads().map((r) => r.method)).toEqual(['POST', 'PATCH', 'PATCH']);
    await expect(downloadedSha1(hash)).resolves.toBe(hash);
  });

  it('still sends small files whole to a limited server', async () => {
    await UploadService._rememberChunkSize(limited.url, 1 * MiB);
    const file = bigPhoto('small.jpg', 600 * KiB);

    const result = await UploadService.uploadAsset(addToCameraRoll(file));

    expect(result).toMatchObject({ success: true, hash: sha1(file) });
    expect(limited.uploads().map((r) => [r.method, r.length])).toEqual([['POST', fs.statSync(file).size]]);
  });

  it('sends a large file whole when nothing limits the request size', async () => {
    await AuthService.updateServerUrl(direct.url);
    const file = bigPhoto('big3.jpg', 3 * MiB);

    const result = await UploadService.uploadAsset(addToCameraRoll(file));

    expect(result).toMatchObject({ success: true, hash: sha1(file) });
    expect(result.chunked).toBeUndefined();
    expect(direct.uploads().map((r) => [r.method, r.length, r.status])).toEqual([['POST', 3 * MiB, 200]]);
    await expect(UploadService.getChunkSize(direct.url)).resolves.toBe(0);
  });

  it('resumes an interrupted upload in pieces when the remainder is too large', async () => {
    const file = bigPhoto('big4.jpg', 3.2 * MiB);
    const hash = sha1(file);
    const data = fs.readFileSync(file);
    // first 1 MiB stored, as if the connection dropped mid-upload (sent straight to lomod)
    await new Promise((resolve) => {
      const req = http.request(`${server.url}/asset/${hash}?ext=jpg`, {
        method: 'POST',
        headers: { Authorization: `token=${AuthService.getToken()}`, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length },
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(data.subarray(0, 1 * MiB), () => setTimeout(() => req.destroy(), 300));
    });
    await waitFor(async () => (await UploadService.checkUploadStatus(hash)).resumable, { what: 'a partial upload' });

    const result = await UploadService.uploadAsset(addToCameraRoll(file));

    expect(result).toMatchObject({ success: true, hash, resumed: true, chunked: true });
    const uploads = limited.uploads();
    expect(uploads[0]).toMatchObject({ method: 'PATCH', status: 413 }); // the 2.2 MiB remainder
    expect(uploads.slice(1).every((r) => r.method === 'PATCH' && r.length <= 1 * MiB)).toBe(true);
    await expect(downloadedSha1(hash)).resolves.toBe(hash);
  });

  it('halves the piece size when the proxy limit is below it', async () => {
    const tight = await startLimitingProxy(server.url, 600 * KiB);
    try {
      await AuthService.updateServerUrl(tight.url);
      const file = bigPhoto('big5.jpg', 2 * MiB);
      const hash = sha1(file);

      const result = await UploadService.uploadAsset(addToCameraRoll(file));

      expect(result).toMatchObject({ success: true, hash, chunked: true });
      const accepted = tight.uploads().filter((r) => r.status !== 413);
      expect(accepted.every((r) => r.length <= 512 * KiB)).toBe(true);
      await expect(UploadService.getChunkSize(tight.url)).resolves.toBe(512 * KiB);
      await expect(downloadedSha1(hash)).resolves.toBe(hash);
    } finally {
      await tight.close();
    }
  });
});
