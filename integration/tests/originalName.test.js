import fs from 'fs';
import * as MediaLibrary from 'expo-media-library';
import AuthService from '../../src/services/AuthService';
import AssetDBService from '../../src/services/AssetDBService';
import SyncService from '../../src/services/SyncService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer } from '../support/harness';
import { notCovered } from '../support/notCovered';

const server = startTestServer('original-name');

const auth = () => ({ Authorization: `token=${AuthService.getToken()}` });

async function cameraRoll() {
  return (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
}

async function listedAsset(hash, [y, m, d]) {
  const res = await fetch(`${server.url}/assets/merkletree/${y}/${m}/${d}`, { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()).Assets.find((a) => a.Hash.toLowerCase() === hash);
}

// What an app from before this change sent: no origname.
async function uploadWithoutName(fixture, createdAt) {
  const hash = sha1(fixturePath(fixture));
  const createtime = encodeURIComponent(new Date(createdAt).toISOString());
  const ext = fixture.split('.').pop();
  const res = await fetch(`${server.url}/asset/${hash}?ext=${ext}&createtime=${createtime}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(fixturePath(fixture)),
  });
  expect(res.status).toBe(200);
  return hash;
}

describe('the name a photo had on the phone', () => {
  const named = sha1(fixturePath('photo-2003-11-01.jpg'));
  let serverKeepsNames = true;

  beforeAll(async () => {
    await registerUser(server);
  });

  it('is sent with the upload, listed by the server, and names the download', async () => {
    const photo = addToCameraRoll('photo-2003-11-01.jpg', {
      filename: 'IMG_été 1.jpg', creationTime: Date.UTC(2003, 10, 1, 12),
    });
    await expect(UploadService.uploadAsset(photo)).resolves.toMatchObject({ success: true, hash: named });

    const listed = await listedAsset(named, [2003, 11, 1]);
    expect(listed).toBeTruthy();
    if (!listed.OrigName) {
      serverKeepsNames = false;
      notCovered('this lomod does not keep original file names');
      return;
    }
    expect(listed.OrigName).toBe('IMG_été 1.jpg');
    expect(listed.Name).not.toBe('IMG_été 1.jpg'); // the server's own name is unchanged

    const download = await fetch(`${server.url}/asset/${named}`, { headers: auth() });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition'))
      .toContain("filename*=UTF-8''IMG_%C3%A9t%C3%A9%201.jpg");
    await download.arrayBuffer();
  });

  it('of photos backed up before uploads carried it is reported by the app on sync', async () => {
    if (!serverKeepsNames) return;
    const older = await uploadWithoutName('photo-2003-11-23.jpg', Date.UTC(2003, 10, 23, 12));
    addToCameraRoll('photo-2003-11-23.jpg', { filename: 'PXL_2.jpg', creationTime: Date.UTC(2003, 10, 23, 12) });
    expect((await listedAsset(older, [2003, 11, 23])).OrigName).toBeUndefined();
    // Name unknown: no file name, and kept a day only, since one may be reported later.
    const unnamed = await fetch(`${server.url}/asset/${older}`, { headers: auth() });
    expect(unnamed.headers.get('content-disposition')).toBeNull();
    expect(unnamed.headers.get('cache-control')).toBe('private, max-age=86400');
    await unnamed.arrayBuffer();

    await AssetDBService.init();
    const roll = await cameraRoll();
    await AssetDBService.insertLocalAssets(roll);
    await SyncService.sync(roll);
    await SyncService.reportOriginalNames();

    expect((await listedAsset(older, [2003, 11, 23])).OrigName).toBe('PXL_2.jpg');
    const namedDownload = await fetch(`${server.url}/asset/${older}`, { headers: auth() });
    expect(namedDownload.headers.get('content-disposition')).toContain("filename*=UTF-8''PXL_2.jpg");
    expect(namedDownload.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    await namedDownload.arrayBuffer();
    const rows = await AssetDBService.getRemoteAssets();
    expect(rows.find((r) => r.hash === older)).toMatchObject({ originalName: 'PXL_2.jpg' });
    // The name the upload carried came down with the listing.
    expect(rows.find((r) => r.hash === named)).toMatchObject({ originalName: 'IMG_été 1.jpg' });
    await expect(AssetDBService.getOriginalNamesToReport()).resolves.toEqual([]);
  });

  it('is kept as first learned, and only for photos the server has', async () => {
    if (!serverKeepsNames) return;
    const res = await fetch(`${server.url}/assets/names`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { Hash: named, Name: 'renamed.jpg' },
        { Hash: 'f'.repeat(40), Name: 'nothing.jpg' },
      ]),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([{ Hash: named, Name: 'IMG_été 1.jpg' }]);
  });

  it('reported by another device reaches this one, though the server tree did not change', async () => {
    if (!serverKeepsNames) return;
    // Backed up by another phone with an old app, then named by that phone later.
    const other = await uploadWithoutName('photo-remote-only.png', Date.UTC(2003, 10, 1, 12));
    await SyncService.sync(await cameraRoll());
    const before = (await AssetDBService.getRemoteAssets()).find((r) => r.hash === other);
    expect(before).toBeTruthy();
    expect(before.originalName).toBeNull();

    const res = await fetch(`${server.url}/assets/names`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Hash: other, Name: 'FROM_OTHER_PHONE.jpg' }]),
    });
    expect(res.status).toBe(200);
    await res.json();

    await SyncService.sync(await cameraRoll());
    await SyncService.reportOriginalNames();

    const after = (await AssetDBService.getRemoteAssets()).find((r) => r.hash === other);
    expect(after.originalName).toBe('FROM_OTHER_PHONE.jpg');
    expect(SyncService.remoteTree.getNodeByHash(other).origName).toBe('FROM_OTHER_PHONE.jpg');
  });

  it('is refused when the request is malformed', async () => {
    if (!serverKeepsNames) return;
    const res = await fetch(`${server.url}/assets/names`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{"not":"a list"}',
    });
    expect(res.status).toBe(400);
    await res.text();
  });
});
