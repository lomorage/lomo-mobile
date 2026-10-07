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
jest.mock('../UploadService', () => ({ checkUploadStatus: jest.fn() }));

const axios = require('axios');
const AssetDBService = require('../AssetDBService');
const MediaService = require('../MediaService');
const UploadService = require('../UploadService');
import BackupSafetyService, { UNSAFE_REASONS } from '../BackupSafetyService';

const row = (id, overrides = {}) => ({ id, hash: `hash-${id}`, hashModificationTime: 1000, uploaded: 1, ...overrides });

// Server answers each requested hash with statuses[hash] (default "ok").
const serverReplies = (statuses = {}) => {
  axios.post.mockImplementation(async (url, body) => ({
    data: { assets: body.hashes.map(hash => ({ hash, status: statuses[hash] || 'ok' })) },
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
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

test('each server status maps to a reason; only not_found and file_missing queue a re-upload', async () => {
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
    { id: 'weird', reason: UNSAFE_REASONS.SERVER_UNREACHABLE },
  ]);
  expect(AssetDBService.markAssetNotUploaded.mock.calls.map(c => c[0]).sort()).toEqual(['fm', 'nf']);
});

test('hash missing from the server reply is not treated as safe', async () => {
  AssetDBService.getBackupRowsByIds.mockResolvedValue([row('a')]);
  axios.post.mockResolvedValue({ data: { assets: [] } });
  const result = await BackupSafetyService.checkBeforeDelete(['a']);
  expect(result.unsafe).toEqual([{ id: 'a', reason: UNSAFE_REASONS.SERVER_UNREACHABLE }]);
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
