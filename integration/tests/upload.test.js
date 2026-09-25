import http from 'http';
import fs from 'fs';
import AuthService from '../../src/services/AuthService';
import MediaService from '../../src/services/MediaService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer, waitFor } from '../support/harness';

const server = startTestServer('upload');

// Sends the first `bytes` of a file as a full-size upload, then drops the
// connection -- what the server sees when a phone loses Wi-Fi mid-upload.
function interruptedUpload(hash, file, bytes) {
  const data = fs.readFileSync(file);
  return new Promise((resolve) => {
    const req = http.request(`${server.url}/asset/${hash}?ext=jpg`, {
      method: 'POST',
      headers: {
        Authorization: `token=${AuthService.getToken()}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
      },
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.write(data.subarray(0, bytes), () => setTimeout(() => req.destroy(), 300));
  });
}

describe('backing up camera-roll assets to lomod', () => {
  beforeAll(async () => {
    await registerUser(server);
  });

  it('uploads a photo, and the server stores it under the file SHA-1', async () => {
    const photo = addToCameraRoll('photo-2003-11-01.jpg');
    const expectedHash = sha1(fixturePath('photo-2003-11-01.jpg'));

    const progress = [];
    const result = await UploadService.uploadAsset(photo, (p) => progress.push(p.fraction));

    expect(result).toEqual({ success: true, hash: expectedHash });
    expect(progress[progress.length - 1]).toBe(1);
    await expect(UploadService.checkUploadStatus(expectedHash)).resolves.toEqual({ exists: true });
  });

  it('skips re-uploading an asset the server already has', async () => {
    const samePhotoAgain = addToCameraRoll('photo-2003-11-01.jpg', { filename: 'copy.jpg' });

    const result = await UploadService.uploadAsset(samePhotoAgain);

    expect(result).toMatchObject({ success: true, duplicate: true });
  });

  it('uploads a video', async () => {
    const video = addToCameraRoll('video-2013-08-08.mp4');

    const result = await UploadService.uploadAsset(video);

    expect(result).toMatchObject({ success: true, hash: sha1(fixturePath('video-2013-08-08.mp4')) });
  });

  it('resumes an interrupted upload from where the server left off', async () => {
    const file = fixturePath('photo-2003-11-23.jpg');
    const hash = sha1(file);
    const size = fs.statSync(file).size;

    await interruptedUpload(hash, file, Math.floor(size / 2));
    const partial = await waitFor(
      async () => {
        const status = await UploadService.checkUploadStatus(hash);
        return status.resumable ? status : null;
      },
      { what: 'the server to report a partial upload (206)' },
    );
    expect(partial.receivedBytes).toBeGreaterThan(0);
    expect(partial.receivedBytes).toBeLessThan(size);

    const result = await UploadService.uploadAsset(addToCameraRoll('photo-2003-11-23.jpg'));

    expect(result).toMatchObject({ success: true, hash, resumed: true });
    await expect(UploadService.checkUploadStatus(hash)).resolves.toEqual({ exists: true });
  });

  it('serves a generated preview at the width the app asks for', async () => {
    const hash = sha1(fixturePath('photo-2003-11-01.jpg'));
    const url = MediaService.getPreviewUrl(hash, 'photo');

    const res = await waitFor(
      async () => {
        const r = await fetch(url);
        return r.ok ? r : null;
      },
      { timeoutMs: 30000, what: `a preview at ${url}` },
    );
    expect(res.headers.get('content-type')).toMatch(/^image\//);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('deletes an asset from the server by hash', async () => {
    const hash = sha1(fixturePath('video-2013-08-08.mp4'));

    await expect(MediaService.deleteRemoteAsset(hash, true)).resolves.toBe(true);

    await expect(UploadService.checkUploadStatus(hash)).resolves.toEqual({ exists: false });
  });
});
