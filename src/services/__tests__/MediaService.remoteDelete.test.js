import axios from 'axios';
import MediaService, { failedDeletes } from '../MediaService';
import { deleteRemoteKeepingFailures } from '../../utils/remoteCleanup';

jest.mock('axios');
jest.mock('../../../modules/expo-lomo-hasher', () => ({}));
jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://pc:8000',
  getToken: () => 'tok',
}));

// What lomod answers to DELETE /asset: 200 with each item's own result.
const answer = (...items) => ({ status: 200, data: { List: items } });

describe('deleting from the server', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a photo the server deleted', async () => {
    axios.delete.mockResolvedValue(answer({ ID: 'h1', Type: 1, Result: true }));
    await expect(MediaService.deleteRemoteAsset('h1', true)).resolves.toBe(true);
  });

  test('a photo the server kept fails with its reason, though the answer is 200', async () => {
    axios.delete.mockResolvedValue(answer({ ID: 'h1', Type: 1, Result: false, Reason: 'file in use' }));
    await expect(MediaService.deleteRemoteAsset('h1', true)).rejects.toThrow('file in use');
  });

  test('in bulk, the ones the server kept are returned', async () => {
    axios.delete.mockResolvedValue(answer(
      { ID: 'h1', Result: true },
      { ID: 'h2', Result: false, Reason: 'file in use' },
    ));
    await expect(MediaService.deleteRemoteAssets([{ idOrHash: 'h1', isHash: true }, { idOrHash: 'h2', isHash: true }]))
      .resolves.toEqual({ failed: ['h2'] });
  });

  test('an answer without per-item results counts as deleted, as before', () => {
    expect(failedDeletes(undefined)).toEqual([]);
    expect(failedDeletes({})).toEqual([]);
  });
});

describe('cleaning up duplicates', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the photos the server kept are the ones whose rows stay', async () => {
    axios.delete.mockResolvedValue(answer({ ID: 'h1', Result: true }, { ID: 'H2', Result: false }));
    const kept = await deleteRemoteKeepingFailures([{ idOrHash: 'h1', isHash: true }, { idOrHash: 'h2', isHash: true }]);
    expect([...kept]).toEqual(['h2']);
  });

  test('if the request fails, every photo stays', async () => {
    axios.delete.mockRejectedValue(new Error('Network Error'));
    const kept = await deleteRemoteKeepingFailures([{ idOrHash: 'h1', isHash: true }, { idOrHash: 'h2', isHash: true }]);
    expect([...kept].sort()).toEqual(['h1', 'h2']);
  });

  test('nothing to delete on the server, nothing kept', async () => {
    await expect(deleteRemoteKeepingFailures([])).resolves.toEqual(new Set());
    expect(axios.delete).not.toHaveBeenCalled();
  });
});
