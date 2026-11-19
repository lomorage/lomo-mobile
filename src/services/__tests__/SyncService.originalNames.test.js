import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(),
  getAssetInfo: jest.fn(),
}));

let mockServerUrl = 'http://localhost:8000';
let mockToken = 'token-a';
jest.mock('../AuthService', () => ({
  getServerUrl: () => mockServerUrl,
  getToken: () => mockToken,
}));

const mockSyncState = new Map();
jest.mock('../AssetDBService', () => ({
  getOriginalNamesToReport: jest.fn(),
  setRemoteOriginalNames: jest.fn().mockResolvedValue(),
  getSyncState: jest.fn(async (key) => (mockSyncState.has(key) ? mockSyncState.get(key) : null)),
  setSyncState: jest.fn(async (key, value) => { mockSyncState.set(key, String(value)); }),
}));

jest.mock('axios');

// What AssetDBService.getOriginalNamesToReport does with its skip set, over a fixed backlog.
function backlog(entries) {
  AssetDBService.getOriginalNamesToReport.mockImplementation(async (limit, skip) =>
    entries.filter((e) => !skip.has(e.hash)).slice(0, limit));
}

const emptyFeed = { data: { Rev: 0, Names: [], More: false } };

describe('SyncService original names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncState.clear();
    mockServerUrl = 'http://localhost:8000';
    mockToken = 'token-a';
    SyncService._namesPass = null;
    SyncService._namesAgain = false;
    SyncService._namesState = undefined;
    SyncService.remoteTree = null;
    axios.get.mockResolvedValue(emptyFeed);
  });

  describe('reporting', () => {
    test('sends the names the server lacks and records what it confirms', async () => {
      backlog([{ hash: 'h1', name: 'IMG_1.jpg' }, { hash: 'h2', name: 'IMG_2.jpg' }]);
      axios.post.mockResolvedValue({ data: [{ Hash: 'h1', Name: 'IMG_1.jpg' }, { Hash: 'h2', Name: 'earlier.jpg' }] });

      await SyncService.reportOriginalNames();

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith('http://localhost:8000/assets/names',
        [{ Hash: 'h1', Name: 'IMG_1.jpg' }, { Hash: 'h2', Name: 'IMG_2.jpg' }],
        expect.objectContaining({ headers: { Authorization: 'token=token-a' } }));
      expect(AssetDBService.setRemoteOriginalNames).toHaveBeenCalledWith([
        { hash: 'h1', name: 'IMG_1.jpg' }, { hash: 'h2', name: 'earlier.jpg' },
      ]);
    });

    test('a long backlog goes in batches, and a name the server does not answer for is not resent', async () => {
      const entries = Array.from({ length: 450 }, (_, i) => ({ hash: `h${i}`, name: `IMG_${i}.jpg` }));
      backlog(entries);
      axios.post.mockResolvedValue({ data: [] }); // e.g. the photos were deleted on the server

      await SyncService.reportOriginalNames();
      await SyncService.reportOriginalNames();

      expect(axios.post.mock.calls.map((c) => c[1].length)).toEqual([200, 200, 50]);
    });

    test('an older server without the endpoint is not asked again', async () => {
      backlog([{ hash: 'h1', name: 'IMG_1.jpg' }]);
      axios.post.mockRejectedValue({ response: { status: 404 } });

      await SyncService.reportOriginalNames();
      await SyncService.reportOriginalNames();

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
      expect(AssetDBService.setRemoteOriginalNames).not.toHaveBeenCalled();
    });

    test('after switching to a server that has it, the same photo is reported there', async () => {
      backlog([{ hash: 'h1', name: 'IMG_1.jpg' }]);
      axios.post.mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValue({ data: [{ Hash: 'h1', Name: 'IMG_1.jpg' }] });

      await SyncService.reportOriginalNames();
      mockServerUrl = 'http://other:8000';
      mockToken = 'token-b';
      await SyncService.reportOriginalNames();

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls[1][0]).toBe('http://other:8000/assets/names');
      expect(axios.post.mock.calls[1][1]).toEqual([{ Hash: 'h1', Name: 'IMG_1.jpg' }]);
    });

    test("switching between a server's home and remote address keeps its state", async () => {
      backlog([{ hash: 'h1', name: 'IMG_1.jpg' }]);
      axios.post.mockResolvedValue({ data: [] });

      await SyncService.reportOriginalNames();
      mockServerUrl = 'https://remote.example:8443';
      await SyncService.reportOriginalNames();

      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('a network failure leaves the names for the next sync', async () => {
      backlog([{ hash: 'h1', name: 'IMG_1.jpg' }]);
      axios.post.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ data: [{ Hash: 'h1', Name: 'IMG_1.jpg' }] });

      await SyncService.reportOriginalNames();
      await SyncService.reportOriginalNames();

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(AssetDBService.setRemoteOriginalNames).toHaveBeenCalledWith([{ hash: 'h1', name: 'IMG_1.jpg' }]);
    });

    test('a call during a pass waits for it, and what was saved meanwhile gets one more round', async () => {
      const entries = [{ hash: 'h1', name: 'IMG_1.jpg' }];
      backlog(entries);
      let release;
      axios.post
        .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ data: [] }); }))
        .mockResolvedValue({ data: [] });

      const first = SyncService.reportOriginalNames();
      await new Promise((r) => setImmediate(r));
      entries.push({ hash: 'h2', name: 'IMG_2.jpg' }); // e.g. a hash saved while the first request ran
      let secondDone = false;
      const second = SyncService.reportOriginalNames().then(() => { secondDone = true; });
      await new Promise((r) => setImmediate(r));
      expect(secondDone).toBe(false);
      release();
      await Promise.all([first, second]);

      expect(axios.post.mock.calls.map((c) => c[1].map((e) => e.Hash))).toEqual([['h1'], ['h2']]);
    });
  });

  describe('names other devices reported', () => {
    beforeEach(() => backlog([]));

    test('are fetched page by page from where this phone left off, into the rows and the cached tree', async () => {
      const node = { origName: null };
      SyncService.remoteTree = { getNodeByHash: (h) => (h === 'aa' ? node : null) };
      const save = jest.spyOn(SyncService, 'saveRemoteTree').mockResolvedValue();
      axios.get
        .mockResolvedValueOnce({ data: { Rev: 7, Names: [{ Hash: 'AA', Name: 'IMG_A.jpg' }], More: true } })
        .mockResolvedValueOnce({ data: { Rev: 9, Names: [{ Hash: 'bb', Name: 'IMG_B.jpg' }], More: false } });

      await SyncService.reportOriginalNames();

      expect(axios.get.mock.calls.map((c) => c[0])).toEqual([
        'http://localhost:8000/assets/names?since=0',
        'http://localhost:8000/assets/names?since=7',
      ]);
      expect(AssetDBService.setRemoteOriginalNames).toHaveBeenCalledWith([{ hash: 'aa', name: 'IMG_A.jpg' }]);
      expect(AssetDBService.setRemoteOriginalNames).toHaveBeenCalledWith([{ hash: 'bb', name: 'IMG_B.jpg' }]);
      expect(node.origName).toBe('IMG_A.jpg');
      expect(save).toHaveBeenCalledTimes(1);
      save.mockRestore();

      // The next sync asks only for what came after.
      axios.get.mockClear();
      axios.get.mockResolvedValue({ data: { Rev: 9, Names: [], More: false } });
      await SyncService.reportOriginalNames();
      expect(axios.get.mock.calls.map((c) => c[0])).toEqual(['http://localhost:8000/assets/names?since=9']);
    });

    test('each account keeps its own place in the feed', async () => {
      axios.get.mockResolvedValue({ data: { Rev: 5, Names: [{ Hash: 'aa', Name: 'A.jpg' }], More: false } });
      await SyncService.reportOriginalNames();

      mockToken = 'token-b';
      axios.get.mockClear();
      await SyncService.reportOriginalNames();

      expect(axios.get.mock.calls[0][0]).toBe('http://localhost:8000/assets/names?since=0');
      expect([...mockSyncState.keys()].join()).not.toContain('token');
    });

    test('a failed fetch keeps the place, to resume next sync', async () => {
      axios.get.mockRejectedValueOnce(new Error('timeout'));
      await SyncService.reportOriginalNames();
      expect(AssetDBService.setSyncState).not.toHaveBeenCalled();

      axios.get.mockResolvedValue({ data: { Rev: 3, Names: [{ Hash: 'aa', Name: 'A.jpg' }], More: false } });
      await SyncService.reportOriginalNames();
      expect(axios.get.mock.calls[1][0]).toBe('http://localhost:8000/assets/names?since=0');
      expect(AssetDBService.setRemoteOriginalNames).toHaveBeenCalledWith([{ hash: 'aa', name: 'A.jpg' }]);
    });
  });
});
