import * as MediaLibrary from 'expo-media-library';
import AuthService from '../../src/services/AuthService';
import AssetDBService from '../../src/services/AssetDBService';
import MediaService from '../../src/services/MediaService';
import SyncService from '../../src/services/SyncService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer } from '../support/harness';

const server = startTestServer('dates');

async function serverInfo(hash) {
  const res = await fetch(`${server.url}/asset/${hash}?info=1`, {
    headers: { Authorization: `token=${AuthService.getToken()}` },
  });
  expect(res.status).toBe(200);
  return JSON.stringify(await res.json());
}

describe('the date a photo is filed under on the computer', () => {
  beforeAll(async () => {
    await registerUser(server);
  });

  it('no OS taken date: the EXIF date the phone reads, the same one its timeline uses', async () => {
    // Android reports no DATE_TAKEN for photos whose EXIF date has no time zone; expo gives 0.
    // The phone-side EXIF here deliberately differs from the file's own (2003-11-23), to show the
    // server files it under what the phone sent rather than re-reading the file.
    const photo = addToCameraRoll('photo-2003-11-23.jpg', {
      creationTime: 0,
      modificationTime: Date.UTC(2026, 9, 8, 0, 12),
      exif: { DateTimeOriginal: '2005:05:05 10:00:00' },
    });

    await expect(UploadService.uploadAsset(photo)).resolves.toMatchObject({ success: true });

    const info = await serverInfo(sha1(fixturePath('photo-2003-11-23.jpg')));
    expect(info).toContain('2005-05-05');
    expect(info).not.toContain('2026');
  });

  it('and the phone files it under the same day, so both hash trees bucket it alike', async () => {
    // What HomeScreen does on a library load: record local rows, read missing EXIF dates, apply them.
    await AssetDBService.init();
    let roll = (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
    await AssetDBService.insertLocalAssets(roll);
    await AssetDBService.setExifTakenTimes(await MediaService.readMissingTakenTimes(roll, new Map()));
    roll = (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
    MediaService.applyKnownTakenTimes(roll, await AssetDBService.getExifTakenTimes());

    await SyncService.sync(roll);

    const hash = sha1(fixturePath('photo-2003-11-23.jpg'));
    const dayPath = (node) => [node.parentNode.parentNode.parentNode.id, node.parentNode.parentNode.id, node.parentNode.id].join('/');
    const local = SyncService.localTree.getNodeByHash(hash);
    const remote = SyncService.remoteTree.getNodeByHash(hash);
    expect(local && remote).toBeTruthy();
    expect(dayPath(local)).toBe(dayPath(remote));
    expect(dayPath(local)).toMatch(/^2005\//);

    // the stored row gets the EXIF date too (On This Day and other date queries read createTime)
    const photo = roll.find(a => a.filename === 'photo-2003-11-23.jpg');
    const row = await AssetDBService.db.getFirstAsync('SELECT createTime FROM MediaAsset WHERE id = ?', [photo.id]);
    expect(row.createTime).toBe(new Date(2005, 4, 5, 10, 0, 0).getTime());
  });

  it('a taken date the phone reports is used as is', async () => {
    const photo = addToCameraRoll('photo-2003-11-01.jpg', { creationTime: Date.UTC(2010, 5, 15, 12) });

    await UploadService.uploadAsset(photo);

    expect(await serverInfo(sha1(fixturePath('photo-2003-11-01.jpg')))).toContain('2010-06-15');
  });

  it('no taken date and no EXIF date: the file time, never the upload day', async () => {
    const photo = addToCameraRoll('photo-remote-only.png', { creationTime: 0, modificationTime: Date.UTC(2012, 5, 1, 12) });

    await UploadService.uploadAsset(photo);

    expect(await serverInfo(sha1(fixturePath('photo-remote-only.png')))).toContain('2012-06-01');
  });
});
