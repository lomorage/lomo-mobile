import SyncService from '../SyncService';
import axios from 'axios';
import AssetDBService from '../AssetDBService';
import ThumbnailLoadTracker from '../ThumbnailLoadTracker';
import { AppState } from 'react-native';

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(uri => Promise.resolve(`hash_${uri.split('/').pop()}`)),
  getAssetInfo: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/doc/dir/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue('{}'),
}));

jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'test-token',
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn((algo, str) => Promise.resolve(`digest_${str}`)),
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
}));

jest.mock('../AssetDBService', () => ({
  init: jest.fn().mockResolvedValue(),
  syncRemoteAssets: jest.fn().mockResolvedValue(),
  syncUploadedStatus: jest.fn().mockResolvedValue(),
  insertRemoteAssets: jest.fn().mockResolvedValue(),
  getRemoteAssetsWithoutGeo: jest.fn().mockResolvedValue([]),
  getLocalAssetsWithoutGeo: jest.fn().mockResolvedValue([]),
  updateAssetsGeo: jest.fn().mockResolvedValue(),
  markAssetsGeoProcessed: jest.fn().mockResolvedValue(),
  getRemoteAssets: jest.fn().mockResolvedValue([]),
  getRemoteAssetsCount: jest.fn().mockResolvedValue(0),
  updateRemoteAssetFilenames: jest.fn().mockResolvedValue(),
  getLocalHashesMap: jest.fn().mockResolvedValue({}),
  updateAssetHash: jest.fn().mockResolvedValue(),
  repairRemoteAssetTimestamps: jest.fn().mockResolvedValue(),
}));

jest.mock('../ThumbnailLoadTracker', () => ({
  isActive: jest.fn(),
}));

jest.mock('axios');

describe('SyncService.fetchRemoteOverview backs off for active thumbnail loads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    SyncService.localTree = new (SyncService.localTree.constructor)();
    SyncService.remoteTree = new (SyncService.remoteTree.constructor)();
    SyncService._remoteTreeLoadedFromDisk = false;
    AppState.currentState = 'active';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const monthLevelData = {
    Hash: 'new_root_hash',
    Years: [
      {
        Year: 2024,
        Hash: 'year_hash',
        Months: [{ Month: 1, Hash: 'hash_jan_new' }],
      },
    ],
  };

  test('waits for thumbnails to stop loading before fetching changed-month details', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/assets/merkletree')) {
        return Promise.resolve({ data: monthLevelData });
      }
      if (url.includes('/assets/merkletree/2024/1')) {
        return Promise.resolve({ data: { Days: [] } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    ThumbnailLoadTracker.isActive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const runPromise = SyncService.fetchRemoteOverview();

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(5000);
    await runPromise;

    expect(ThumbnailLoadTracker.isActive).toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/assets/merkletree/2024/1?all=1',
      expect.any(Object)
    );
  });

  test('does not wait when no thumbnails are loading', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/assets/merkletree')) {
        return Promise.resolve({ data: monthLevelData });
      }
      if (url.includes('/assets/merkletree/2024/1')) {
        return Promise.resolve({ data: { Days: [] } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    ThumbnailLoadTracker.isActive.mockReturnValue(false);

    const runPromise = SyncService.fetchRemoteOverview();
    await jest.advanceTimersByTimeAsync(5000);
    await runPromise;

    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/assets/merkletree/2024/1?all=1',
      expect.any(Object)
    );
  });
});
