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

  describe('without a known account', () => {
    const root = 'file:///cache/share/unknown/';
    const removed = () => FileSystem.deleteAsync.mock.calls.map(([p]) => p).filter((p) => p.startsWith(root));

    beforeEach(() => {
      mockAccountId = null;
    });

    test('each share gets its own copy, and copies over an hour old are removed', async () => {
      const old = `${Date.now() - 2 * 60 * 60 * 1000}-a`;
      const recent = `${Date.now() - 60 * 1000}-b`;
      FileSystem.readDirectoryAsync.mockImplementation(async (p) => {
        if (p === root) return [old, recent];
        throw new Error('no such folder');
      });

      const first = await prepareRemoteShareFile(asset);
      const second = await prepareRemoteShareFile(asset);

      expect(first).not.toBe(second);
      expect(first.startsWith(root)).toBe(true);
      expect(removed()).toContain(`${root}${old}`);
      expect(removed()).not.toContain(`${root}${recent}`);
    });

    test("a share started from another screen doesn't remove a copy still downloading", async () => {
      let finishFirst;
      let firstDir;
      FileSystem.downloadAsync.mockImplementationOnce((url, path) => {
        firstDir = path.slice(root.length).split('/')[0];
        return new Promise((resolve) => { finishFirst = () => resolve(downloaded); });
      });
      // By the second share the first copy's folder is over an hour old (Date.now moved below),
      // so only being in use protects it.
      FileSystem.readDirectoryAsync.mockImplementation(async (p) => {
        if (p === root && firstDir) return [firstDir];
        throw new Error('no such folder');
      });
      const first = prepareRemoteShareFile(asset);
      await new Promise((r) => setImmediate(r));

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
      await prepareRemoteShareFile(asset);
      Date.now.mockRestore();
      finishFirst();

      await expect(first).resolves.toContain(firstDir);
      expect(removed()).not.toContain(`${root}${firstDir}`);
    });
  });

  test('a copy kept for this account is reused, renamed to the original name', async () => {
    FileSystem.readDirectoryAsync.mockResolvedValue(['20240101_1.jpg']);

    const uri = await prepareRemoteShareFile(asset);

    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(uri).toMatch(/\/h1\/IMG_1\.jpg$/);
  });
});
