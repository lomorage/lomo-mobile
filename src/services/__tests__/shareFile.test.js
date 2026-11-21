import * as FileSystem from 'expo-file-system/legacy';
import { prepareRemoteShareFile } from '../shareFile';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  readDirectoryAsync: jest.fn(),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  downloadAsync: jest.fn(),
  moveAsync: jest.fn().mockResolvedValue(),
  deleteAsync: jest.fn().mockResolvedValue(),
}));

let mockSession = 1;
let mockAccountId = 'srv|id:7';
jest.mock('../AuthService', () => ({
  getSession: () => mockSession,
  getServerUrl: () => 'http://pc:8000',
  getToken: () => 'tok',
  getAccountId: () => mockAccountId,
}));

const asset = { hash: 'h1', filename: '20240101_1.jpg', originalName: 'IMG_1.jpg' };
const downloaded = { status: 200, headers: {} };

describe('prepareRemoteShareFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = 1;
    mockAccountId = 'srv|id:7';
    FileSystem.readDirectoryAsync.mockRejectedValue(new Error('no such folder'));
    FileSystem.downloadAsync.mockResolvedValue(downloaded);
  });

  test("downloads into the account's folder under the photo's own name", async () => {
    const uri = await prepareRemoteShareFile(asset);

    expect(uri).toMatch(/^file:\/\/\/cache\/share\/[0-9a-f]+\/h1\/IMG_1\.jpg$/);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///cache/share/unknown/', expect.anything());
  });

  test('nothing for the share sheet when the account changed during the download', async () => {
    FileSystem.downloadAsync.mockImplementation(async () => {
      mockSession = 2; // signed in to another account meanwhile
      return downloaded;
    });

    await expect(prepareRemoteShareFile(asset)).resolves.toBeNull();
  });

  test('without a known account, earlier one-off copies are removed before a new one', async () => {
    mockAccountId = null;

    const first = await prepareRemoteShareFile(asset);
    const second = await prepareRemoteShareFile(asset);

    expect(first).not.toBe(second);
    expect(first.startsWith('file:///cache/share/unknown/')).toBe(true);
    const cleared = FileSystem.deleteAsync.mock.calls.filter(([p]) => p === 'file:///cache/share/unknown/');
    expect(cleared).toHaveLength(2);
    // The clearing comes before each download, so at most one copy is kept.
    const order = FileSystem.deleteAsync.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(FileSystem.downloadAsync.mock.invocationCallOrder[0]);
  });

  test('a copy kept for this account is reused, renamed to the original name', async () => {
    FileSystem.readDirectoryAsync.mockResolvedValue(['20240101_1.jpg']);

    const uri = await prepareRemoteShareFile(asset);

    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(uri).toMatch(/\/h1\/IMG_1\.jpg$/);
  });
});
