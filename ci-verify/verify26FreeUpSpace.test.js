// CI verification for PR #26 (copied into integration/tests/ by .github/workflows/verify-23-26.yml).
// Real service layer + real SQLite (node:sqlite) + real lomod: back up a camera roll, run the same
// steps Free Up Space runs after the OS deletes the originals, and look at what the Photos grid
// (local roll + AssetDBService.getRemoteAssets) and Backup Status (free-up candidates + at-home
// counts) would read. Measurements go to integration/.artifacts/verify26.json for both the base and
// the PR build, then the expectations of the fix are asserted.
import fs from 'fs';
import path from 'path';
import * as MediaLibrary from 'expo-media-library';
import AssetDBService from '../../src/services/AssetDBService';
import BackupSafetyService from '../../src/services/BackupSafetyService';
import SyncService from '../../src/services/SyncService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll } from '../support/cameraRoll';
import { registerUser, startTestServer } from '../support/harness';

jest.mock('../../src/services/AutoBackupManager', () => ({ __esModule: true, default: { canUploadNow: async () => true } }));

const server = startTestServer('verify26');
const OUT = path.join(__dirname, '..', '.artifacts', 'verify26.json');
const report = { variant: process.env.VARIANT || 'unknown', steps: {} };

async function roll() {
  return (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
}

async function snapshot(label) {
  const remote = await AssetDBService.getRemoteAssets();
  const local = await roll();
  const rows = await AssetDBService.db.getAllAsync('SELECT id, hash, isLocal FROM MediaAsset ORDER BY hash, isLocal');
  const candidates = [
    ...(await AssetDBService.getFreeUpSpaceCandidates('photo')),
    ...(await AssetDBService.getFreeUpSpaceCandidates('video')),
  ];
  const atHome = typeof AssetDBService.getAtHomeCounts === 'function' ? await AssetDBService.getAtHomeCounts() : 'n/a (no getAtHomeCounts on this build)';
  const localHashes = new Set(rows.filter(r => r.isLocal === 1).map(r => r.hash));
  // HomeScreen merges the roll with remote rows; a remote row whose hash is still on the phone is
  // shown once (as the local item), so the grid is local + remote rows not on the phone.
  const remoteOnly = remote.filter(r => !localHashes.has(r.hash));
  const s = {
    cameraRoll: local.length,
    dbRows: rows,
    remoteRows: remote.length,
    remoteUniqueHashes: new Set(remote.map(r => r.hash)).size,
    gridItemsApprox: local.length + remoteOnly.length,
    freeUpCandidates: candidates.length,
    atHome,
  };
  report.steps[label] = s;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return s;
}

describe('PR #26: library after Free Up Space', () => {
  const N_PHOTOS = 3;
  let ids;

  beforeAll(async () => {
    await registerUser(server);
    const fixtures = ['photo-2003-11-01.jpg', 'photo-2003-11-23.jpg', 'photo-remote-only.png'];
    fixtures.forEach((f, i) => addToCameraRoll(f, { creationTime: Date.UTC(2003, 10, 1 + i, 12) }));
    addToCameraRoll('video-2013-08-08.mp4', { creationTime: Date.UTC(2013, 7, 8, 12) });
    await AssetDBService.init();
    const r = await roll();
    ids = r.map(a => a.id);
    await AssetDBService.insertLocalAssets(r);
    await SyncService.sync(r);
    for (const a of r) await UploadService.uploadAsset(a);
    // the backup's own sync afterwards: brings the hash-keyed remote rows down
    await SyncService.sync(await roll());
  }, 120000);

  it('records the state before / after freeing / after the next sync', async () => {
    const before = await snapshot('1_afterBackup');
    expect(before.freeUpCandidates).toBe(N_PHOTOS + 1);

    // FreeUpSpaceScreen.handleDelete -> BackupSafetyService.checkAll; deleteVerified ->
    // MediaService.deleteLocalAssets (OS delete) + AssetDBService.markAssetsRemovedLocally
    const check = await BackupSafetyService.checkAll(ids, () => {});
    report.safeToDelete = check.safe.length;
    expect(check.safe.sort()).toEqual([...ids].sort());
    await MediaLibrary.deleteAssetsAsync(check.safe);
    await AssetDBService.markAssetsRemovedLocally(check.safe);
    await snapshot('2_rightAfterFreeUp');

    await SyncService.sync(await roll());
    await snapshot('3_afterNextSync');
  }, 120000);

  it('right after freeing space: one grid item per photo, no duplicate remote rows', () => {
    const s = report.steps['2_rightAfterFreeUp'];
    expect(s.cameraRoll).toBe(0);
    expect(s.remoteUniqueHashes).toBe(N_PHOTOS + 1);
    expect(s.remoteRows).toBe(N_PHOTOS + 1);
    expect(s.gridItemsApprox).toBe(N_PHOTOS + 1);
  });

  it('right after freeing space: Backup Status has the at-home counts to show', () => {
    const s = report.steps['2_rightAfterFreeUp'];
    expect(s.freeUpCandidates).toBe(0);
    expect(s.atHome).toEqual({ photos: N_PHOTOS, videos: 1 });
  });
});
