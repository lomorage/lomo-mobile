import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';
import ThumbnailLoadTracker from '../ThumbnailLoadTracker';
import { AppState } from 'react-native';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(),
  getAssetInfo: jest.fn(),
}));

jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'test-token',
}));

jest.mock('../AssetDBService', () => ({
  getRemoteAssetsWithoutGeo: jest.fn(),
  updateAssetsGeo: jest.fn().mockResolvedValue(),
  markAssetsGeoProcessed: jest.fn().mockResolvedValue(),
}));

jest.mock('../ThumbnailLoadTracker', () => ({
  isActive: jest.fn(),
}));

jest.mock('axios');

describe('SyncService.syncRemoteGPS backs off for active thumbnail loads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    SyncService._isSyncingGPS = false;
    AppState.currentState = 'active';
    global.currentGpsThrottle = undefined;
    global.lastMemoryWarning = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('waits while thumbnails are actively loading before firing metadata requests', async () => {
    AssetDBService.getRemoteAssetsWithoutGeo
      .mockResolvedValueOnce([{ id: 1, hash: 'abc' }])
      .mockResolvedValueOnce([]);
    axios.get.mockResolvedValue({ data: { Latitude: 1, Longitude: 2 } });

    // Thumbnails are loading for the first two polls, then finish.
    ThumbnailLoadTracker.isActive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const runPromise = SyncService.syncRemoteGPS();

    // Let the backoff loop poll a couple of times before it clears.
    await jest.advanceTimersByTimeAsync(1000);
    // Drain the remaining batch delay / promise chain.
    await jest.advanceTimersByTimeAsync(5000);
    await runPromise;

    expect(ThumbnailLoadTracker.isActive).toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/asset/metadata/abc',
      expect.any(Object)
    );
  });

  test('does not wait when no thumbnails are loading', async () => {
    AssetDBService.getRemoteAssetsWithoutGeo
      .mockResolvedValueOnce([{ id: 1, hash: 'abc' }])
      .mockResolvedValueOnce([]);
    axios.get.mockResolvedValue({ data: { Latitude: 1, Longitude: 2 } });
    ThumbnailLoadTracker.isActive.mockReturnValue(false);

    const runPromise = SyncService.syncRemoteGPS();
    await jest.advanceTimersByTimeAsync(5000);
    await runPromise;

    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/asset/metadata/abc',
      expect.any(Object)
    );
  });

  test('fires a batch in chunks of at most 3 concurrent requests, not all at once', async () => {
    const pending = Array.from({ length: 7 }, (_, i) => ({ id: i, hash: `hash${i}` }));
    AssetDBService.getRemoteAssetsWithoutGeo
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce([]);
    ThumbnailLoadTracker.isActive.mockReturnValue(false);

    // Track how many axios.get calls are in flight (started but not yet resolved)
    // at any point in time, so we can assert it never exceeds the chunk size.
    let inFlight = 0;
    let maxInFlight = 0;
    const pendingResolvers = [];
    axios.get.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise(resolve => {
        pendingResolvers.push(() => {
          inFlight--;
          resolve({ data: { Latitude: 1, Longitude: 2 } });
        });
      });
    });

    const runPromise = SyncService.syncRemoteGPS();

    // Drain chunk-by-chunk: let each chunk's requests start, then resolve them,
    // repeating until all 7 assets have been processed.
    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(0);
      const toResolve = pendingResolvers.splice(0, pendingResolvers.length);
      toResolve.forEach(r => r());
      await jest.advanceTimersByTimeAsync(3000);
    }

    await jest.advanceTimersByTimeAsync(5000);
    await runPromise;

    expect(axios.get).toHaveBeenCalledTimes(7);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});
