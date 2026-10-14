jest.mock('axios');
jest.mock('../AssetDBService', () => ({
  getBackupRowsByIds: jest.fn(),
  markAssetNotUploaded: jest.fn(() => Promise.resolve()),
}));
jest.mock('../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));
jest.mock('../MediaService', () => ({ getAssetInfo: jest.fn() }));
jest.mock('../UploadService', () => ({ checkUploadStatus: jest.fn(), uploadAsset: jest.fn(async (asset) => ({ success: true, hash: asset.hash })) }));
jest.mock('../AutoBackupManager', () => ({ __esModule: true, default: { canUploadNow: jest.fn(async () => true) } }));

const axios = require('axios');
const AssetDBService = require('../AssetDBService');
const MediaService = require('../MediaService');
const UploadService = require('../UploadService');
const AutoBackupManager = require('../AutoBackupManager').default;
import BackupSafetyService, { UNSAFE_REASONS } from '../BackupSafetyService';

const row = (id, overrides = {}) => ({ id, hash: `hash-${id}`, hashModificationTime: 1000, uploaded: 1, ...overrides });

// Server answers each requested hash with statuses[hash] (default "ok").
const serverReplies = (statuses = {}, extra = {}) => {
  axios.post.mockImplementation(async (url, body) => ({
    data: { assets: body.hashes.map(hash => ({ hash, status: statuses[hash] || 'ok' })), ...extra },
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
  AutoBackupManager.canUploadNow.mockImplementation(async () => true);
  BackupSafetyService.restoring = Promise.resolve();
  BackupSafetyService.restorePending.clear();
  BackupSafetyService.restoredListeners.clear();
  BackupSafetyService.restoredSinceNotify = 0;
  MediaService.getAssetInfo.mockResolvedValue({ modificationTime: 1000.4 });
  serverReplies();
});

test('asset that is uploaded, unchanged and verified by the server is safe', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a')]);
  await expect(BackupSafetyService.checkBeforeDelete(['a'])).resolves.toEqual({ safe: ['a'], unsafe: [], weakEvidence: false });
  expect(axios.post).toHaveBeenCalledWith(
    'http://localhost:8000/assets/verify',
    { hashes: ['hash-a'] },
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'token=test-token' }) }),
  );
  expect(UploadService.checkUploadStatus).not.toHaveBeenCalled();
});

test('never-uploaded or unhashed assets are not safe and are not sent to the server', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a', { uploaded: 0 }), row('b', { hash: null })]);
  const result = await BackupSafetyService.checkBeforeDelete(['a', 'b', 'c']);
  expect(result.safe).toEqual([]);
  expect(result.unsafe.map(u => u.reason)).toEqual([
    UNSAFE_REASONS.NOT_BACKED_UP, UNSAFE_REASONS.NOT_BACKED_UP, UNSAFE_REASONS.NOT_BACKED_UP,
  ]);
  expect(axios.post).not.toHaveBeenCalled();
});

test('asset edited after it was hashed, or with no recorded hash time, is not safe', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a'), row('b', { hashModificationTime: null })]);
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ modificationTime: id === 'a' ? 2000 : 1000 }));
  const result = await BackupSafetyService.checkBeforeDelete(['a', 'b']);
  expect(result.unsafe).toEqual([
    { id: 'a', reason: UNSAFE_REASONS.MODIFIED_SINCE_BACKUP },
    { id: 'b', reason: UNSAFE_REASONS.MODIFIED_SINCE_BACKUP },
  ]);
});

test('asset missing on the phone is reported, not deleted', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a')]);
  MediaService.getAssetInfo.mockResolvedValue(null);
  const result = await BackupSafetyService.checkBeforeDelete(['a']);
  expect(result.unsafe).toEqual([{ id: 'a', reason: UNSAFE_REASONS.MISSING_LOCALLY }]);
});

test('each server status maps to a reason; only not_found queues a re-upload', async () => {
  const ids = ['ok', 'nf', 'fm', 'ln', 'bd', 'un', 'weird'];
  AssetDBService.getBackupRowsByIds.mockResolvedValue(ids.map(id => row(id)));
  serverReplies({
    'hash-nf': 'not_found', 'hash-fm': 'file_missing', 'hash-ln': 'linked',
    'hash-bd': 'bad', 'hash-un': 'unavailable', 'hash-weird': 'something_new',
  });
  const result = await BackupSafetyService.checkBeforeDelete(ids);
  expect(result.safe).toEqual(['ok']);
  expect(result.unsafe).toEqual([
    { id: 'nf', reason: UNSAFE_REASONS.MISSING_ON_SERVER },
    { id: 'fm', reason: UNSAFE_REASONS.FILE_MISSING },
    { id: 'ln', reason: UNSAFE_REASONS.LINKED_ONLY },
    { id: 'bd', reason: UNSAFE_REASONS.DAMAGED },
    { id: 'un', reason: UNSAFE_REASONS.STORAGE_UNAVAILABLE },
    { id: 'weird', reason: UNSAFE_REASONS.UNCONFIRMED },
  ]);
  expect(AssetDBService.markAssetNotUploaded.mock.calls.map(c => c[0])).toEqual(['nf']);
});

test('file_missing on a server that can repair: uploaded again right away to put the file back', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('ok'), row('fm'), row('nf')]);
  serverReplies({ 'hash-fm': 'file_missing', 'hash-nf': 'not_found' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));

  const result = await BackupSafetyService.checkBeforeDelete(['ok', 'fm', 'nf']);
  await BackupSafetyService.restoring;

  expect(result.unsafe).toEqual([
    { id: 'fm', reason: UNSAFE_REASONS.FILE_MISSING_RESTORING },
    { id: 'nf', reason: UNSAFE_REASONS.MISSING_ON_SERVER },
  ]);
  // not via the next backup: the server still lists the hash, so that would never upload it
  expect(UploadService.uploadAsset.mock.calls.map(c => [c[0].id, c[0].hash])).toEqual([['fm', 'hash-fm']]);
  expect(AssetDBService.markAssetNotUploaded.mock.calls.map(c => c[0])).toEqual(['nf']);
});

test('file_missing on an older server: kept on the phone, no upload it would refuse', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' });
  const result = await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;
  expect(result.unsafe).toEqual([{ id: 'fm', reason: UNSAFE_REASONS.FILE_MISSING }]);
  expect(UploadService.uploadAsset).not.toHaveBeenCalled();
});

test('a failed restore is logged, not thrown', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' }, { repair: true });
  UploadService.uploadAsset.mockRejectedValueOnce(new Error('Network Error'));
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await expect(BackupSafetyService.restoring).resolves.toBeUndefined();
});

test('file_missing while the backup settings forbid uploading (e.g. Wi-Fi only on mobile data): not restored now', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' }, { repair: true });
  AutoBackupManager.canUploadNow.mockResolvedValue(false);

  const result = await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;

  expect(result.unsafe).toEqual([{ id: 'fm', reason: UNSAFE_REASONS.FILE_MISSING }]);
  expect(UploadService.uploadAsset).not.toHaveBeenCalled();
});

test('settings that change mid-way stop the remaining restores, which the next check queues again', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a'), row('b')]);
  serverReplies({ 'hash-a': 'file_missing', 'hash-b': 'file_missing' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  // allowed for the check and the first restore, then the phone leaves Wi-Fi
  AutoBackupManager.canUploadNow
    .mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

  await BackupSafetyService.checkBeforeDelete(['a', 'b']);
  await BackupSafetyService.restoring;

  expect(UploadService.uploadAsset.mock.calls.map(c => c[0].id)).toEqual(['a']);
  expect(BackupSafetyService.restorePending.size).toBe(0);
});

test('checking again while a restore is queued does not queue it twice', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  let finishUpload;
  UploadService.uploadAsset.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));

  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await new Promise(setImmediate);
  finishUpload({ success: true });
  await BackupSafetyService.restoring;

  expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
});

test('onRestored fires after a file is put back, not after a failed restore', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  const listener = jest.fn();
  const unsubscribe = BackupSafetyService.onRestored(listener);

  UploadService.uploadAsset.mockRejectedValueOnce(new Error('Network Error'));
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;
  expect(listener).not.toHaveBeenCalled();

  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;
  expect(listener).toHaveBeenCalledTimes(1);
});

test('a re-upload that put nothing back (server already had it, or another hash) does not count as restored', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('fm')]);
  serverReplies({ 'hash-fm': 'file_missing' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  const listener = jest.fn();
  BackupSafetyService.onRestored(listener);

  UploadService.uploadAsset.mockResolvedValueOnce({ success: true, duplicate: true, hash: 'hash-fm' });
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;
  UploadService.uploadAsset.mockResolvedValueOnce({ success: true, hash: 'some-other-hash' });
  await BackupSafetyService.checkBeforeDelete(['fm']);
  await BackupSafetyService.restoring;

  expect(UploadService.uploadAsset).toHaveBeenCalledTimes(2);
  expect(listener).not.toHaveBeenCalled();
});

test('onRestored fires once when the whole queue has drained, not after every batch', async () => {
  AssetDBService.getBackupRowsByIds.mockImplementation(async (ids) => ids.map(id => row(id)));
  serverReplies({ 'hash-a': 'file_missing', 'hash-b': 'file_missing' }, { repair: true });
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  const listener = jest.fn();
  BackupSafetyService.onRestored(listener);
  let finishFirst;
  UploadService.uploadAsset.mockImplementationOnce((asset) => new Promise((resolve) => {
    finishFirst = () => resolve({ success: true, hash: asset.hash });
  }));

  // two checks queue two batches, the way checkAll queues a large library 500 at a time
  await BackupSafetyService.checkBeforeDelete(['a']);
  await BackupSafetyService.checkBeforeDelete(['b']);
  await new Promise(setImmediate);
  finishFirst();
  await BackupSafetyService.restoring;

  expect(UploadService.uploadAsset.mock.calls.map(c => c[0].id)).toEqual(['a', 'b']);
  expect(listener).toHaveBeenCalledTimes(1);
});

test('repair is only trusted when every batch of the reply offers it', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `id${i}`);
  AssetDBService.getBackupRowsByIds.mockResolvedValue(ids.map(id => row(id)));
  MediaService.getAssetInfo.mockImplementation(async (id) => ({ id, modificationTime: 1000.4 }));
  let call = 0;
  axios.post.mockImplementation(async (url, body) => ({
    data: { assets: body.hashes.map(hash => ({ hash, status: 'file_missing' })), repair: call++ === 0 },
  }));

  const result = await BackupSafetyService.checkBeforeDelete(ids);

  expect(new Set(result.unsafe.map(u => u.reason))).toEqual(new Set([UNSAFE_REASONS.FILE_MISSING]));
  expect(UploadService.uploadAsset).not.toHaveBeenCalled();
});

test('hash missing from the server reply is not treated as safe', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a')]);
  axios.post.mockResolvedValue({ data: { assets: [] } });
  const result = await BackupSafetyService.checkBeforeDelete(['a']);
  expect(result.unsafe).toEqual([{ id: 'a', reason: UNSAFE_REASONS.UNCONFIRMED }]);
});

test('server hash matching is case-insensitive', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a', { hash: 'ABCDEF' })]);
  axios.post.mockResolvedValue({ data: { assets: [{ hash: 'abcdef', status: 'ok' }] } });
  await expect(BackupSafetyService.checkBeforeDelete(['a'])).resolves.toMatchObject({ safe: ['a'] });
});

test('unreachable server: nothing is safe and no upload flags change', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a'), row('b')]);
  axios.post.mockRejectedValue(new Error('Network Error'));
  const result = await BackupSafetyService.checkBeforeDelete(['a', 'b']);
  expect(result.safe).toEqual([]);
  expect(result.unsafe.every(u => u.reason === UNSAFE_REASONS.SERVER_UNREACHABLE)).toBe(true);
  expect(AssetDBService.markAssetNotUploaded).not.toHaveBeenCalled();
  expect(UploadService.checkUploadStatus).not.toHaveBeenCalled();
});

test('large selections are verified in batches of 500', async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `id${i}`);
  AssetDBService.getBackupRowsByIds.mockResolvedValue(ids.map(id => row(id)));
  const result = await BackupSafetyService.checkBeforeDelete(ids);
  expect(axios.post.mock.calls.map(c => c[1].hashes.length)).toEqual([500, 500, 201]);
  expect(result.safe).toHaveLength(1201);
});

test('checkAll verifies a whole library in batches and reports progress', async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
  AssetDBService.getBackupRowsByIds.mockImplementation(async (batch) => batch.map(id => row(id)));
  serverReplies({ 'hash-id1000': 'file_missing' });
  const progress = [];
  const result = await BackupSafetyService.checkAll(ids, (done, total) => progress.push([done, total]));
  expect(progress).toEqual([[500, 1001], [1000, 1001], [1001, 1001]]);
  expect(result.safe).toHaveLength(1000);
  expect(result.unsafe).toEqual([{ id: 'id1000', reason: UNSAFE_REASONS.FILE_MISSING }]);
  expect(result.weakEvidence).toBe(false);
});

describe.each([404, 405])('older server without /assets/verify (HTTP %i)', (httpStatus) => {
  beforeEach(() => {
    axios.post.mockRejectedValue(Object.assign(new Error('Unsupported'), { response: { status: httpStatus } }));
  });

  test('falls back to HEAD and flags the evidence as weak', async () => {
    AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a'), row('b'), row('c')]);
    UploadService.checkUploadStatus.mockImplementation(async (hash) => {
      if (hash === 'hash-c') throw new Error('Network Error');
      return { exists: hash === 'hash-a' };
    });
    const result = await BackupSafetyService.checkBeforeDelete(['a', 'b', 'c']);
    expect(result).toEqual({
      safe: ['a'],
      unsafe: [
        { id: 'b', reason: UNSAFE_REASONS.MISSING_ON_SERVER },
        { id: 'c', reason: UNSAFE_REASONS.SERVER_UNREACHABLE },
      ],
      weakEvidence: true,
    });
    expect(AssetDBService.markAssetNotUploaded).toHaveBeenCalledWith('b');
    expect(AssetDBService.markAssetNotUploaded).not.toHaveBeenCalledWith('c');
  });
});
