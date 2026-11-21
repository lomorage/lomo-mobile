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

    // The temp root's folders, kept by the mocked file system: downloads add one, renames move it.
    let folders;
    const HOUR = 60 * 60 * 1000;
    const useFakeFolders = () => {
      folders = new Set();
      FileSystem.downloadAsync.mockImplementation(async (url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        return downloaded;
      });
      FileSystem.moveAsync.mockImplementation(async ({ from, to }) => {
        if (!from.startsWith(root) || from.slice(root.length).includes('/')) return;
        folders.delete(from.slice(root.length));
        folders.add(to.slice(root.length));
      });
      FileSystem.deleteAsync.mockImplementation(async (p) => { folders.delete(p.slice(root.length)); });
      FileSystem.readDirectoryAsync.mockImplementation(async (p) => {
        if (p === root) return [...folders];
        throw new Error('no such folder');
      });
    };
    const folderOf = (uri) => uri.slice(root.length).split('/')[0];

    test('a copy whose download took over an hour is kept for the hour after it was handed over', async () => {
      useFakeFolders();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      FileSystem.downloadAsync.mockImplementationOnce(async (url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        clock.mockReturnValue(start + 2 * HOUR); // a slow download
        return downloaded;
      });

      const first = await prepareRemoteShareFile(asset);
      expect(folderOf(first).startsWith(`${start + 2 * HOUR}-`)).toBe(true); // stamped at handover
      expect(folders.has(folderOf(first))).toBe(true);

      clock.mockReturnValue(start + 2 * HOUR + 60 * 1000); // shared again a minute later
      await prepareRemoteShareFile(asset);
      expect(folders.has(folderOf(first))).toBe(true);

      clock.mockReturnValue(start + 4 * HOUR); // and again two hours later
      await prepareRemoteShareFile(asset);
      expect(folders.has(folderOf(first))).toBe(false);
      clock.mockRestore();
    });

    test('nothing for the share sheet when the account changed during the rename', async () => {
      useFakeFolders();
      const realMove = FileSystem.moveAsync.getMockImplementation();
      FileSystem.moveAsync.mockImplementation(async (args) => {
        if (args.from.startsWith(root) && !args.from.slice(root.length).includes('/')) mockSession = 2;
        return realMove(args);
      });
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      FileSystem.downloadAsync.mockImplementationOnce(async (url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        clock.mockReturnValue(start + 5000); // so the folder gets a new stamp
        return downloaded;
      });

      await expect(prepareRemoteShareFile(asset)).resolves.toBeNull();
      expect(FileSystem.moveAsync).toHaveBeenCalledWith(expect.objectContaining({ to: expect.stringContaining(`${start + 5000}-`) }));
      clock.mockRestore();
    });

    test('the handover time survives an app restart', async () => {
      useFakeFolders();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      FileSystem.downloadAsync.mockImplementationOnce(async (url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        clock.mockReturnValue(start + 2 * HOUR);
        return downloaded;
      });
      const first = await prepareRemoteShareFile(asset);

      let afterRestart;
      jest.isolateModules(() => { afterRestart = require('../shareFile').prepareRemoteShareFile; });
      clock.mockReturnValue(start + 2 * HOUR + 60 * 1000);
      await afterRestart(asset);

      expect(folders.has(folderOf(first))).toBe(true);
      clock.mockRestore();
    });

    test("a share started from another screen doesn't remove a copy still downloading", async () => {
      useFakeFolders();
      let finishFirst;
      FileSystem.downloadAsync.mockImplementationOnce((url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        return new Promise((resolve) => { finishFirst = () => resolve(downloaded); });
      });
      const first = prepareRemoteShareFile(asset);
      await new Promise((r) => setImmediate(r));
      const [running] = [...folders];

      // By the second share the first copy's folder is over an hour old, so only being in use
      // protects it.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * HOUR);
      await prepareRemoteShareFile(asset);
      expect(folders.has(running)).toBe(true);
      finishFirst();

      const uri = await first;
      clock.mockRestore();
      expect(folders.has(folderOf(uri))).toBe(true);
      expect(uri.endsWith('/h1/IMG_1.jpg')).toBe(true);
    });

    test('if the folder cannot be renamed, the copy still counts from its handover', async () => {
      useFakeFolders();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      FileSystem.downloadAsync.mockImplementationOnce(async (url, path) => {
        folders.add(path.slice(root.length).split('/')[0]);
        clock.mockReturnValue(start + 2 * HOUR);
        return downloaded;
      });
      const realMove = FileSystem.moveAsync.getMockImplementation();
      FileSystem.moveAsync.mockImplementation(async (args) => {
        if (args.from.startsWith(root) && !args.from.slice(root.length).includes('/')) throw new Error('busy');
        return realMove(args);
      });
      const first = await prepareRemoteShareFile(asset);

      clock.mockReturnValue(start + 2 * HOUR + 60 * 1000);
      await prepareRemoteShareFile(asset);
      expect(folders.has(folderOf(first))).toBe(true);
      clock.mockRestore();
    });
  });

  test('a copy kept for this account is reused, renamed to the original name', async () => {
    FileSystem.readDirectoryAsync.mockResolvedValue(['20240101_1.jpg']);

    const uri = await prepareRemoteShareFile(asset);

    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(uri).toMatch(/\/h1\/IMG_1\.jpg$/);
  });
});
