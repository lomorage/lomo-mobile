import fs from 'fs';
import path from 'path';
import * as MediaLibrary from 'expo-media-library';
import AuthService from '../../src/services/AuthService';
import AssetDBService from '../../src/services/AssetDBService';
import BackupSafetyService, { UNSAFE_REASONS } from '../../src/services/BackupSafetyService';
import SyncService from '../../src/services/SyncService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer } from '../support/harness';

const server = startTestServer('backup-safety');

// The library copy lomod keeps for a hash: <media>/<user>/Photos/master/YYYY/MM/DD/YYYYMMDD_<id>.<ext>
function findMasterFile(dir, extension) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findMasterFile(p, extension);
      if (found) return found;
    } else if (p.includes(`${path.sep}master${path.sep}`) && p.endsWith(extension)) {
      return p;
    }
  }
  return null;
}

async function verifyRaw(hashes) {
  const res = await fetch(`${server.url}/assets/verify`, {
    method: 'POST',
    headers: { Authorization: `token=${AuthService.getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('checking backups before freeing up space', () => {
  let photo;
  let video;
  const photoHash = sha1(fixturePath('photo-2003-11-01.jpg'));
  const videoHash = sha1(fixturePath('video-2013-08-08.mp4'));

  beforeAll(async () => {
    await registerUser(server);
    photo = addToCameraRoll('photo-2003-11-01.jpg', { creationTime: Date.UTC(2003, 10, 1, 12) });
    video = addToCameraRoll('video-2013-08-08.mp4', { creationTime: Date.UTC(2013, 7, 8, 12) });
    const roll = (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
    // HomeScreen records the camera roll in the local DB; SyncService then hashes it.
    await AssetDBService.init();
    await AssetDBService.insertLocalAssets(roll);
    await SyncService.sync(roll);
    await UploadService.uploadAsset(photo);
    await UploadService.uploadAsset(video);
  });

  it('lomod vouches for uploaded assets and reports unknown hashes', async () => {
    const body = await verifyRaw([photoHash, videoHash, 'ffffffffffffffffffffffffffffffffffffffff']);

    // lomod's startup maintenance may already have run a consistency check, so the
    // evidence is either the upload-time SHA1 check or that check.
    const evidence = expect.stringMatching(/^(upload|ccheck)$/);
    expect(body.assets).toEqual([
      { hash: photoHash, status: 'ok', evidence, checkedAt: expect.any(Number) },
      { hash: videoHash, status: 'ok', evidence, checkedAt: expect.any(Number) },
      { hash: 'ffffffffffffffffffffffffffffffffffffffff', status: 'not_found' },
    ]);
  });

  it('records each upload\'s size, so Free Up Space can total what can be freed', async () => {
    const [videoRow] = await AssetDBService.getFreeUpSpaceCandidates('video');
    expect(videoRow).toMatchObject({ id: video.id, hash: videoHash, fileSize: fs.statSync(fixturePath('video-2013-08-08.mp4')).size });

    const rows = await AssetDBService.getBackupSummaryRows();
    const byType = Object.fromEntries(rows.map(r => [r.mediaType, r]));
    expect(byType.photo).toMatchObject({ total: 1, backedUp: 1, unknownSize: 0 });
    expect(byType.video).toMatchObject({ total: 1, backedUp: 1, unknownSize: 0 });
  });

  it('backed-up, unchanged assets are safe to delete', async () => {
    const result = await BackupSafetyService.checkBeforeDelete([photo.id, video.id]);

    expect(result).toEqual({ safe: [photo.id, video.id], unsafe: [], weakEvidence: false });
  });

  it('an asset whose file vanished from the computer stays on the phone', async () => {
    const videoFile = findMasterFile(server.baseDir, '.mp4');
    expect(videoFile).toBeTruthy();
    fs.rmSync(videoFile);

    const result = await BackupSafetyService.checkBeforeDelete([photo.id, video.id]);

    expect(result.safe).toEqual([photo.id]);
    expect(result.unsafe).toEqual([{ id: video.id, reason: UNSAFE_REASONS.FILE_MISSING }]);
    const [row] = await AssetDBService.getBackupRowsByIds([video.id]);
    // The server still lists the hash, so a re-upload would be refused (409); don't pretend.
    expect(row.uploaded).toBe(1);
  });

  it('an asset deleted on the server is kept on the phone', async () => {
    const res = await fetch(`${server.url}/asset`, {
      method: 'DELETE',
      headers: { Authorization: `token=${AuthService.getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ List: [{ ID: photoHash, Type: 1 }] }),
    });
    expect(res.status).toBe(200);

    const result = await BackupSafetyService.checkBeforeDelete([photo.id]);

    expect(result.unsafe).toEqual([{ id: photo.id, reason: UNSAFE_REASONS.MISSING_ON_SERVER }]);
  });
});
