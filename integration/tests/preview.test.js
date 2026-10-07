import fs from 'fs';
import path from 'path';
import AuthService from '../../src/services/AuthService';
import MediaService from '../../src/services/MediaService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer, waitFor } from '../support/harness';

const server = startTestServer('preview');

// Every preview file lomod has written, e.g. ".../preview/2003/11/01/20031101_1_320_0.webp".
function previewFiles() {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/_\d+_\d+\.(webp|jpg|png|mp4)$/.test(e.name)) found.push(p);
    }
  };
  walk(server.baseDir);
  return found.sort();
}

describe('preview URLs hit the previews lomod pre-generates', () => {
  const photoHash = sha1(fixturePath('photo-2003-11-01.jpg'));
  const videoHash = sha1(fixturePath('video-2013-08-08.mp4'));

  beforeAll(async () => {
    await registerUser(server);
    await UploadService.uploadAsset(addToCameraRoll('photo-2003-11-01.jpg'));
    await UploadService.uploadAsset(addToCameraRoll('video-2013-08-08.mp4'));
    // Background generation after upload: 75/320/640 image previews for both assets, plus the
    // video's 480 mp4 (written to a dot-prefixed temp file first). Wait for all of it so the
    // tests below only see files their own requests create.
    await waitFor(() => {
      const files = previewFiles();
      const done = (suffix) => files.filter((f) => !path.basename(f).startsWith('.') && f.endsWith(suffix));
      return done('_320_0.webp').length >= 2 && done('_640_0.webp').length >= 2
        && done('_480_0.mp4').length >= 1 && !files.some((f) => path.basename(f).startsWith('.'));
    }, { timeoutMs: 60000, what: 'background preview generation to finish' });
  }, 120000);

  it('learns from /system at login that the server pre-generates WebP', () => {
    expect(AuthService.supportsWebpPreview()).toBe(true);
  });

  it.each([
    ['photo thumbnail', photoHash, 'photo', false],
    ['photo large', photoHash, 'photo', true],
    ['video thumbnail', videoHash, 'video', false],
    ['video large', videoHash, 'video', true],
  ])('serves the %s from cache without generating anything', async (_name, hash, type, large) => {
    const before = previewFiles();

    const res = await fetch(MediaService.getPreviewUrl(hash, type, large));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(previewFiles()).toEqual(before);
  });

  it('(the old JPEG URL made the server transcode a new preview on demand)', async () => {
    const before = previewFiles();
    const token = AuthService.getToken();

    const res = await fetch(`${server.url}/preview/${photoHash}?width=320&height=-1&token=${token}`);

    expect(res.status).toBe(200);
    const created = previewFiles().filter((f) => !before.includes(f));
    expect(created).toEqual([expect.stringMatching(/_320_0\.jpg$/)]);
  });
});
