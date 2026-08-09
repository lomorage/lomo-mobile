jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock-cache/',
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../MediaService', () => ({}));
jest.mock('../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));
jest.mock('../../../modules/expo-lomo-hasher', () => ({ sliceFileAsync: jest.fn() }));

const axios = require('axios');
const AuthService = require('../AuthService');
import UploadService from '../UploadService';

beforeEach(() => {
  jest.clearAllMocks();
  AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
  AuthService.getToken.mockReturnValue('test-token');
  UploadService.activeTasks = new Map();
  UploadService.activePromises = new Map();
  UploadService.cancelledTasks = new Set();
});

describe('checkUploadStatus', () => {
  test('returns { exists: false } without a request when server url/token/hash are missing', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    await expect(UploadService.checkUploadStatus('abc123')).resolves.toEqual({ exists: false });
    expect(axios.head).not.toHaveBeenCalled();
  });

  test('lowercases the hash in the request URL', async () => {
    axios.head.mockResolvedValue({ status: 200, headers: {} });
    await UploadService.checkUploadStatus('ABC123');
    expect(axios.head).toHaveBeenCalledWith(
      'http://localhost:8000/asset/abc123',
      expect.anything()
    );
  });

  test('200 and 409 both mean the asset already exists', async () => {
    axios.head.mockResolvedValue({ status: 200, headers: {} });
    await expect(UploadService.checkUploadStatus('h1')).resolves.toEqual({ exists: true });

    axios.head.mockResolvedValue({ status: 409, headers: {} });
    await expect(UploadService.checkUploadStatus('h1')).resolves.toEqual({ exists: true });
  });

  test('206 parses the received byte count out of the If-Match header', async () => {
    axios.head.mockResolvedValue({
      status: 206,
      headers: { 'if-match': 'size=12345, sha1=deadbeef' },
    });
    await expect(UploadService.checkUploadStatus('h1')).resolves.toEqual({
      exists: false, resumable: true, receivedBytes: 12345, ifMatch: 'size=12345, sha1=deadbeef',
    });
  });

  test('206 falls back to 0 received bytes when the If-Match header is missing', async () => {
    axios.head.mockResolvedValue({ status: 206, headers: {} });
    const result = await UploadService.checkUploadStatus('h1');
    expect(result.resumable).toBe(true);
    expect(result.receivedBytes).toBe(0);
  });

  test('206 falls back to 0 received bytes when If-Match has no parseable size', async () => {
    axios.head.mockResolvedValue({ status: 206, headers: { 'if-match': 'sha1=deadbeef' } });
    const result = await UploadService.checkUploadStatus('h1');
    expect(result.receivedBytes).toBe(0);
  });

  test('any other 2xx/3xx status falls through to not-exists', async () => {
    axios.head.mockResolvedValue({ status: 204, headers: {} });
    await expect(UploadService.checkUploadStatus('h1')).resolves.toEqual({ exists: false });
  });

  test('a 404 error means not-yet-uploaded, not a failure', async () => {
    axios.head.mockRejectedValue({ response: { status: 404 } });
    await expect(UploadService.checkUploadStatus('h1')).resolves.toEqual({ exists: false });
  });

  test('rethrows a 500 error instead of assuming not-uploaded (would force a wasted full re-upload)', async () => {
    axios.head.mockRejectedValue({ response: { status: 500 }, message: 'server error' });
    await expect(UploadService.checkUploadStatus('h1')).rejects.toBeTruthy();
  });

  test('rethrows a network error (no response at all, e.g. timeout)', async () => {
    axios.head.mockRejectedValue(new Error('Network Error'));
    await expect(UploadService.checkUploadStatus('h1')).rejects.toThrow('Network Error');
  });
});

describe('cancelUpload / cancelAllUploads', () => {
  test('cancelUpload marks the asset cancelled and cancels its active task if present', () => {
    const task = { cancelAsync: jest.fn().mockResolvedValue() };
    UploadService.activeTasks.set('asset1', task);

    UploadService.cancelUpload('asset1');

    expect(UploadService.cancelledTasks.has('asset1')).toBe(true);
    expect(task.cancelAsync).toHaveBeenCalled();
  });

  test('cancelUpload is safe to call for an asset with no active task', () => {
    expect(() => UploadService.cancelUpload('never-started')).not.toThrow();
    expect(UploadService.cancelledTasks.has('never-started')).toBe(true);
  });

  test('cancelAllUploads cancels every active task and marks them all cancelled', () => {
    const task1 = { cancelAsync: jest.fn().mockResolvedValue() };
    const task2 = { cancelAsync: jest.fn().mockResolvedValue() };
    UploadService.activeTasks.set('a1', task1);
    UploadService.activeTasks.set('a2', task2);

    UploadService.cancelAllUploads();

    expect(task1.cancelAsync).toHaveBeenCalled();
    expect(task2.cancelAsync).toHaveBeenCalled();
    expect(UploadService.cancelledTasks.has('a1')).toBe(true);
    expect(UploadService.cancelledTasks.has('a2')).toBe(true);
  });
});

describe('uploadAsset de-duplication', () => {
  test('a second call for the same asset while one is in flight reuses the same promise', async () => {
    let resolveExecute;
    const executeSpy = jest.spyOn(UploadService, '_executeUpload').mockReturnValue(
      new Promise((resolve) => { resolveExecute = resolve; })
    );

    const p1 = UploadService.uploadAsset({ id: 'asset1' });
    const p2 = UploadService.uploadAsset({ id: 'asset1' });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    resolveExecute({ success: true, hash: 'h1' });
    await expect(p1).resolves.toEqual({ success: true, hash: 'h1' });
    await expect(p2).resolves.toEqual({ success: true, hash: 'h1' });

    executeSpy.mockRestore();
  });

  test('cleans up activePromises/activeTasks/cancelledTasks after completion, even on failure', async () => {
    const executeSpy = jest.spyOn(UploadService, '_executeUpload').mockRejectedValue(new Error('upload failed'));

    await expect(UploadService.uploadAsset({ id: 'asset1' })).rejects.toThrow('upload failed');

    expect(UploadService.activePromises.has('asset1')).toBe(false);
    expect(UploadService.activeTasks.has('asset1')).toBe(false);
    expect(UploadService.cancelledTasks.has('asset1')).toBe(false);

    executeSpy.mockRestore();
  });
});
