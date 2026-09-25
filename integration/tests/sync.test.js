import fs from 'fs';
import * as MediaLibrary from 'expo-media-library';
import AuthService from '../../src/services/AuthService';
import AssetDBService from '../../src/services/AssetDBService';
import SyncService from '../../src/services/SyncService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer } from '../support/harness';

const server = startTestServer('sync');

async function cameraRoll() {
  return (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
}

const hashes = (nodes) => nodes.map((n) => n.hash).sort();

// Another device backing up a photo this phone doesn't have.
async function uploadFromAnotherDevice(fixture) {
  const hash = sha1(fixturePath(fixture));
  const ext = fixture.split('.').pop();
  // Like the apps, pass createtime: lomod rejects files without an EXIF date otherwise.
  const createtime = encodeURIComponent(new Date(Date.UTC(2020, 5, 1)).toISOString());
  const res = await fetch(`${server.url}/asset/${hash}?ext=${ext}&createtime=${createtime}`, {
    method: 'POST',
    headers: { Authorization: `token=${AuthService.getToken()}`, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(fixturePath(fixture)),
  });
  expect(res.status).toBe(200);
  return hash;
}

describe('Merkle-tree sync between the camera roll and lomod', () => {
  const photo1 = sha1(fixturePath('photo-2003-11-01.jpg'));
  const photo2 = sha1(fixturePath('photo-2003-11-23.jpg'));
  const video = sha1(fixturePath('video-2013-08-08.mp4'));

  beforeAll(async () => {
    await registerUser(server);
    addToCameraRoll('photo-2003-11-01.jpg', { creationTime: Date.UTC(2003, 10, 1, 12) });
    addToCameraRoll('photo-2003-11-23.jpg', { creationTime: Date.UTC(2003, 10, 23, 12) });
    addToCameraRoll('video-2013-08-08.mp4', { creationTime: Date.UTC(2013, 7, 8, 12) });
  });

  it('on an empty server, everything local needs uploading and nothing downloading', async () => {
    const diff = await SyncService.sync(await cameraRoll());

    expect(hashes(diff.uploadAssets)).toEqual([photo1, photo2, video].sort());
    expect(diff.downloadAssets).toEqual([]);
  });

  it('after backing up part of the roll, only the rest is left to upload', async () => {
    const [first] = (await cameraRoll()).filter((a) => a.filename === 'photo-2003-11-01.jpg');
    await UploadService.uploadAsset(first);

    const diff = await SyncService.sync(await cameraRoll());

    expect(hashes(diff.uploadAssets)).toEqual([photo2, video].sort());
    expect(SyncService.remoteTree.getNodeByHash(photo1)).toBeTruthy();
  });

  it('once everything is backed up, the trees match', async () => {
    for (const asset of await cameraRoll()) await UploadService.uploadAsset(asset);

    const diff = await SyncService.sync(await cameraRoll());

    expect(diff.uploadAssets).toEqual([]);
    expect(diff.downloadAssets).toEqual([]);
    expect(SyncService.remoteTree.assetsMap.size).toBe(3);
  });

  it('assets that exist only on the server show up as downloads and in the local DB', async () => {
    const fromOtherPhone = await uploadFromAnotherDevice('photo-remote-only.png');

    const diff = await SyncService.sync(await cameraRoll());

    expect(diff.uploadAssets).toEqual([]);
    expect(hashes(diff.downloadAssets)).toEqual([fromOtherPhone]);
    const remoteRows = await AssetDBService.getRemoteAssets();
    expect(remoteRows.map((r) => r.hash)).toEqual(expect.arrayContaining([photo1, photo2, video, fromOtherPhone]));
  });

  it('an asset deleted on the server drops out of the remote tree', async () => {
    const res = await fetch(`${server.url}/asset`, {
      method: 'DELETE',
      headers: { Authorization: `token=${AuthService.getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ List: [{ ID: video, Type: 1 }] }),
    });
    expect(res.status).toBe(200);

    const diff = await SyncService.sync(await cameraRoll());

    expect(SyncService.remoteTree.getNodeByHash(video)).toBeFalsy();
    expect(hashes(diff.uploadAssets)).toEqual([video]);
  });
});
