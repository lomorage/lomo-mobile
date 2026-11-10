// A file lomod has no handler for, end to end: the real refusal from a real server, classified
// and recorded in the real SQLite schema.
//
// This is the layer that can check the two things the mocked unit tests cannot. First, that lomod
// really answers an unsupported extension with 400 and a body whose text contains "Not
// implemented" -- the whole skip-instead-of-retry decision hangs on that wording, and an
// lomo-backend change to it would silently return the client to retrying forever. Second, that
// migration 17 and the queries naming its columns work on a database built by the app's own
// schema code rather than by a mock.
//
// The refusal behind the incident this fixes was an AVIF file: 3070 rejected POSTs in 2h50m with
// no upload getting through, because the client treated the 400 as worth retrying.
import fs from 'fs';
import path from 'path';
import MediaLibrary from 'expo-media-library';
import AssetDBService from '../../src/services/AssetDBService';
import SyncService from '../../src/services/SyncService';
import UploadService, { isPermanentReject } from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { kindsOf } from '../../src/screens/backupSummaryHelpers';
import { registerUser, sha1, startTestServer } from '../support/harness';
import sandbox from '../shims/sandbox';

const server = startTestServer('uploadRefused');

// lomod decides on the ext query param before reading a byte (handler/asset.go saveAsset), so the
// contents only have to look like the real thing rather than be decodable.
const AVIF_MAGIC = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // box size + 'ftyp'
  0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00, // 'avif' brand
]);

function makeAvif(name) {
  const file = path.join(sandbox.dir('generated'), name);
  fs.writeFileSync(file, Buffer.concat([AVIF_MAGIC, Buffer.alloc(2048, 7)]));
  return file;
}

describe('a photo this lomod cannot accept', () => {
  let refused;
  let good;
  let refusedHash;

  beforeAll(async () => {
    await registerUser(server);
    refusedHash = sha1(makeAvif('refused-probe.avif'));
    refused = addToCameraRoll(makeAvif('refused.avif'), { filename: 'refused.avif' });
    good = addToCameraRoll('photo-2003-11-01.jpg');
    const roll = (await MediaLibrary.getAssetsAsync({ first: 1000 })).assets;
    // HomeScreen records the camera roll in the local DB; SyncService then hashes it.
    await AssetDBService.init();
    await AssetDBService.insertLocalAssets(roll);
    await SyncService.sync(roll);
  });

  it('is refused by lomod with the wording the client keys on', async () => {
    const error = await UploadService.uploadAsset(refused).then(
      (result) => { throw new Error(`expected a refusal, got ${JSON.stringify(result)}`); },
      (e) => e);

    expect(error.httpStatus).toBe(400);
    // The exact string the allowlist matches. If lomod ever rephrases this, this test is the
    // thing that notices -- not a user whose backup has quietly stopped making progress.
    expect(error.message).toContain('Not implemented');
    expect(isPermanentReject(error.httpStatus, error.message)).toBe(true);
    expect(error.permanentReject).toBe(true);
  });

  it('is not on the server afterwards, so there is nothing to resume', async () => {
    await expect(UploadService.checkUploadStatus(refusedHash)).resolves.toEqual({ exists: false });
  });

  it('is refused again on a second attempt: retrying cannot help', async () => {
    // The premise of skipping it. If a retry could succeed, skipping would lose the photo.
    const error = await UploadService.uploadAsset(refused).then(() => null, (e) => e);

    expect(error).not.toBeNull();
    expect(error.permanentReject).toBe(true);
  });

  it('does not stop lomod accepting the next photo', async () => {
    // The stall was not lomod refusing one file; it was everything behind it never being tried.
    await expect(UploadService.uploadAsset(good))
      .resolves.toMatchObject({ success: true, hash: sha1(fixturePath('photo-2003-11-01.jpg')) });
  });

  describe('once the refusal is recorded', () => {
    beforeAll(async () => {
      await AssetDBService.markUploadRejected(refused.id, 'Not implemented: extension: avif');
    });

    it('took the migration, on a database built by the app\'s own schema code', () => {
      expect(AssetDBService.hasUploadRejected).toBe(true);
    });

    it('is flagged in the hash cache the backup queue filters on', async () => {
      const map = await AssetDBService.getLocalHashesMap();

      expect(map[refused.id]).toMatchObject({
        uploadRejected: true,
        uploadRejectedReason: 'Not implemented: extension: avif',
      });
    });

    it('is listed with the wording the summary names ".avif" from', async () => {
      const rows = await AssetDBService.getUploadRejected();

      expect(rows).toEqual([expect.objectContaining({
        id: refused.id, reason: 'Not implemented: extension: avif',
      })]);
      // insertLocalAssets now stores the name (it used to leave it NULL); the summary still
      // reads the reason first, so either one is enough to name the kind.
      expect(rows[0].filename).toBe('refused.avif');
      expect(kindsOf(rows)).toEqual(['.avif']);
    });

    it('is counted as refused, not as still waiting to be backed up', async () => {
      const byType = Object.fromEntries(
        (await AssetDBService.getBackupSummaryRows()).map(r => [r.mediaType, r]));

      // The good photo above is backed up; the avif is refused. Neither is pending.
      expect(byType.photo).toMatchObject({ total: 2, backedUp: 1, rejected: 1, excluded: 0 });
    });

    it('goes back to waiting when the user asks to try again', async () => {
      // For after the computer's Lomorage is updated. Nothing clears a refusal on its own.
      await expect(AssetDBService.clearUploadRejected()).resolves.toBe(1);

      const map = await AssetDBService.getLocalHashesMap();
      expect(map[refused.id].uploadRejected).toBe(false);
      const byType = Object.fromEntries(
        (await AssetDBService.getBackupSummaryRows()).map(r => [r.mediaType, r]));
      expect(byType.photo).toMatchObject({ total: 2, backedUp: 1, rejected: 0 });
    });
  });
});
