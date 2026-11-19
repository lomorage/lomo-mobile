import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(),
  getAssetInfo: jest.fn(),
}));

let mockServerUrl = 'http://localhost:8000';
jest.mock('../AuthService', () => ({
  getServerUrl: () => mockServerUrl,
  getToken: () => 'test-token',
}));

jest.mock('../AssetDBService', () => ({
  getOriginalNamesToReport: jest.fn(),
  setRemoteOriginalNames: jest.fn().mockResolvedValue(),
}));

jest.mock('axios');

// What AssetDBService.getOriginalNamesToReport does with its skip set, over a fixed backlog.
function backlog(entries) {
  AssetDBService.getOriginalNamesToReport.mockImplementation(async (limit, skip) =>
    entries.filter((e) => !skip.has(e.hash)).slice(0, limit));
}

describe('SyncService.reportOriginalNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockServerUrl = 'http://localhost:8000';
    SyncService._namesPass = null;
    SyncService._namesAgain = false;
    SyncService._namesSent = undefined;
    SyncService._namesUnsupportedOn = undefined;
  });

  test('sends the names the server lacks and records what it confirms', async () => {
    backlog([{ hash: 'h1', name: 'IMG_1.jpg' }, { hash: 'h2', name: 'IMG_2.jpg' }]);
    axios.post.mockResolvedValue({ data: [{ Hash: 'h1', Name: 'IMG_1.jpg' }, { Hash: 'h2', Name: 'earlier.jpg' }] });

    await SyncService.reportOriginalNames();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith('http://localhost:8000/assets/names',
      [{ Hash: 'h1', Name: 'IMG_1.jpg' }, { Hash: 'h2', Name: 'IMG_2.jpg' }],
      expect.objectContaining({ headers: { Authorization: 'token=test-token' } }));
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
    SyncService._namesSent = undefined;
    await SyncService.reportOriginalNames();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(AssetDBService.setRemoteOriginalNames).not.toHaveBeenCalled();
  });

  test('...but a different server is', async () => {
    backlog([{ hash: 'h1', name: 'IMG_1.jpg' }]);
    axios.post.mockRejectedValueOnce({ response: { status: 405 } }).mockResolvedValue({ data: [] });

    await SyncService.reportOriginalNames();
    mockServerUrl = 'http://other:8000';
    SyncService._namesSent = undefined;
    await SyncService.reportOriginalNames();

    expect(axios.post).toHaveBeenCalledTimes(2);
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
