import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';
import { DeviceEventEmitter } from 'react-native';
import { shortKey } from '../../utils/shortKey';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(),
  getAssetInfo: jest.fn(),
}));

let mockServerUrl = 'http://localhost:8000';
let mockToken = 'token-a';
// The account follows the token here; a server's home and remote address share it.
const accountOf = (token) => (token ? `server-uuid|${token}` : null);
jest.mock('../AuthService', () => ({
  getServerUrl: () => mockServerUrl,
  getToken: () => mockToken,
  getAccountId: () => accountOf(mockToken),
}));

const mockSyncState = new Map();
jest.mock('../AssetDBService', () => ({
  init: jest.fn().mockResolvedValue(),
  clearRemoteOriginalNames: jest.fn().mockResolvedValue(),
  getOriginalNamesToReport: jest.fn(),
  setRemoteOriginalNames: jest.fn().mockResolvedValue(),
  getSyncState: jest.fn(async (key) => (mockSyncState.has(key) ? mockSyncState.get(key) : null)),
  setSyncState: jest.fn(async (key, value) => { mockSyncState.set(key, String(value)); }),
}));

jest.mock('axios');

// What AssetDBService.getOriginalNamesToReport does with its cursor, over a fixed backlog.
function backlog(entries) {
  AssetDBService.getOriginalNamesToReport.mockImplementation(async (limit, after) =>
    entries.filter((e) => e.hash > (after || '')).sort((a, b) => (a.hash < b.hash ? -1 : 1)).slice(0, limit));
}

// What the listing (fetchRemoteOverview) records before any names pass: whose names they are.
function namesBelongTo(token) {
  mockSyncState.set('originalNamesAccount', shortKey(accountOf(token)));
}

const emptyFeed = { data: { Rev: 0, Names: [], More: false } };

describe('SyncService original names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncState.clear();
    mockServerUrl = 'http://localhost:8000';
    mockToken = 'token-a';
    namesBelongTo('token-a');
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
      namesBelongTo('token-b');
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

  describe('signing out or switching account mid-request', () => {
    // The answer for account A arrives once B is signed in: the same hash can be B's photo.
    const answerAfterSwitch = (value) => () => new Promise((resolve) => {
      mockToken = 'token-b';
      setImmediate(() => resolve(value));
    });

    test('a report answer for the old account is dropped', async () => {
      backlog([{ hash: 'h1', name: 'IMG_A.jpg' }]);
      axios.post.mockImplementationOnce(answerAfterSwitch({ data: [{ Hash: 'h1', Name: 'IMG_A.jpg' }] }));

      await SyncService.reportOriginalNames();

      expect(AssetDBService.setRemoteOriginalNames).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('names read while the account changed are not sent to the old account', async () => {
      AssetDBService.getOriginalNamesToReport.mockImplementationOnce(async () => {
        mockToken = 'token-b';
        return [{ hash: 'h1', name: 'IMG_B.jpg' }];
      }).mockResolvedValue([]);

      await SyncService.reportOriginalNames();

      expect(axios.post).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('the next feed page is not asked for the old account once the account changed', async () => {
      backlog([]);
      axios.get.mockResolvedValueOnce({ data: { Rev: 1, Names: [{ Hash: 'h1', Name: 'IMG_A.jpg' }], More: true } });
      AssetDBService.setRemoteOriginalNames.mockImplementationOnce(async () => { mockToken = 'token-b'; });

      await SyncService.reportOriginalNames();

      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('a feed page for the old account is dropped, with its place and the cached tree', async () => {
      backlog([]);
      const node = { origName: null };
      SyncService.remoteTree = { getNodeByHash: () => node };
      const save = jest.spyOn(SyncService, 'saveRemoteTree').mockResolvedValue();
      axios.get.mockImplementationOnce(answerAfterSwitch({ data: { Rev: 4, Names: [{ Hash: 'h1', Name: 'IMG_A.jpg' }], More: false } }));

      await SyncService.reportOriginalNames();

      expect(AssetDBService.setRemoteOriginalNames).not.toHaveBeenCalled();
      expect(AssetDBService.setSyncState).not.toHaveBeenCalled();
      expect(node.origName).toBeNull();
      expect(save).not.toHaveBeenCalled();
      save.mockRestore();
    });
  });

  describe('signing in to another account', () => {
    beforeEach(() => {
      jest.spyOn(SyncService, 'clearRemoteTreeCache').mockResolvedValue();
    });
    afterEach(() => {
      SyncService.clearRemoteTreeCache.mockRestore();
    });

    test("drops the confirmed names and the cached tree, and reads the new account's feed from the start", async () => {
      mockToken = 'token-b';
      mockSyncState.set(`originalNamesRev:${shortKey(accountOf('token-b'))}`, '40'); // B, some time ago

      await SyncService._forgetOriginalNamesOfOtherAccount();

      expect(AssetDBService.clearRemoteOriginalNames).toHaveBeenCalledTimes(1);
      expect(SyncService.clearRemoteTreeCache).toHaveBeenCalledTimes(1);
      expect(mockSyncState.get(`originalNamesRev:${shortKey(accountOf('token-b'))}`)).toBe('0');
      expect(mockSyncState.get('originalNamesAccount')).toBe(shortKey(accountOf('token-b')));
    });

    test("at sign-in, when the server couldn't say which account this is, names are dropped anyway", async () => {
      mockToken = null; // stands in for an account id that isn't known yet

      await SyncService.claimOriginalNamesForSignIn();

      expect(AssetDBService.clearRemoteOriginalNames).toHaveBeenCalledTimes(1);
      expect(SyncService.clearRemoteTreeCache).toHaveBeenCalledTimes(1);
      expect(mockSyncState.get('originalNamesAccount')).toBe('');
    });

    test('names cached while the owner was unknown are dropped at the next sign-in', async () => {
      mockSyncState.set('originalNamesAccount', ''); // the previous sign-in couldn't tell its account
      mockToken = 'token-b';

      await SyncService.claimOriginalNamesForSignIn();

      expect(AssetDBService.clearRemoteOriginalNames).toHaveBeenCalledTimes(1);
      expect(SyncService.clearRemoteTreeCache).toHaveBeenCalledTimes(1);
      expect(mockSyncState.get('originalNamesAccount')).toBe(shortKey(accountOf('token-b')));
    });

    test('during sync, an account not known yet leaves the names alone', async () => {
      mockToken = null;

      await SyncService._forgetOriginalNamesOfOtherAccount();

      expect(AssetDBService.clearRemoteOriginalNames).not.toHaveBeenCalled();
    });

    test('keeps everything for the same account', async () => {
      await SyncService._forgetOriginalNamesOfOtherAccount();

      expect(AssetDBService.clearRemoteOriginalNames).not.toHaveBeenCalled();
      expect(SyncService.clearRemoteTreeCache).not.toHaveBeenCalled();
    });

    test('the first time (after updating the app) only records the account', async () => {
      mockSyncState.clear();

      await SyncService._forgetOriginalNamesOfOtherAccount();

      expect(AssetDBService.clearRemoteOriginalNames).not.toHaveBeenCalled();
      expect(SyncService.clearRemoteTreeCache).not.toHaveBeenCalled();
      expect(mockSyncState.get('originalNamesAccount')).toBe(shortKey(accountOf('token-a')));
    });
  });

  describe('the open gallery', () => {
    test('is told to reload when names were recorded', async () => {
      const emit = jest.spyOn(DeviceEventEmitter, 'emit');
      backlog([]);
      axios.get.mockResolvedValue({ data: { Rev: 2, Names: [{ Hash: 'h1', Name: 'IMG_1.jpg' }], More: false } });

      await SyncService.reportOriginalNames();

      expect(emit).toHaveBeenCalledWith('remoteAssetsUpdated');
      emit.mockRestore();
    });

    test('is left alone when nothing new came', async () => {
      const emit = jest.spyOn(DeviceEventEmitter, 'emit');
      backlog([]);

      await SyncService.reportOriginalNames();

      expect(emit).not.toHaveBeenCalledWith('remoteAssetsUpdated');
      emit.mockRestore();
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
      namesBelongTo('token-b');
      axios.get.mockClear();
      await SyncService.reportOriginalNames();

      expect(axios.get.mock.calls[0][0]).toBe('http://localhost:8000/assets/names?since=0');
      expect([...mockSyncState.keys()].join()).not.toContain('token');
    });

    test("nothing is sent or fetched while the names on the phone are still another account's", async () => {
      backlog([{ hash: 'h1', name: 'IMG_A.jpg' }]);
      mockToken = 'token-b'; // signed in to B, but its listing hasn't run yet

      await SyncService.reportOriginalNames();

      expect(axios.post).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
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
