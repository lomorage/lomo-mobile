import SyncService from '../SyncService';

// Mock MediaService - assets in tests already have hashes so this is a fallback
jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(uri => {
    if (!uri) return Promise.resolve(null);
    return Promise.resolve(`hash_${uri.split('/').pop()}`);
  }),
  getAssetInfo: jest.fn(() => Promise.resolve(null)),
}));

// Mock expo-file-system to avoid real FS calls
jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/doc/dir/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'test-token',
}));

// Mock expo-crypto for Merkle hash calculations
jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn(),
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
}));

// Assets with pre-set hashes so calculateHash is never called
const mockAssets = [
  { id: '1', hash: 'h1', uri: 'file:///a.jpg', localUri: 'file:///a.jpg', creationTime: new Date('2024-01-01T12:00:00Z').getTime(), modificationTime: 1000 },
  { id: '2', hash: 'h2', uri: 'file:///b.jpg', localUri: 'file:///b.jpg', creationTime: new Date('2024-01-01T13:00:00Z').getTime(), modificationTime: 2000 },
  { id: '3', hash: 'h3', uri: 'file:///c.jpg', localUri: 'file:///c.jpg', creationTime: new Date('2024-02-01T12:00:00Z').getTime(), modificationTime: 3000 },
];

// Deterministic hash function for Merkle nodes in tests
const cryptoMock = str => `digest_${str}`;

describe('SyncService Merkle Tree', () => {
  beforeEach(() => {
    SyncService.localTree = new (SyncService.localTree.constructor)();
    SyncService.remoteTree = new (SyncService.remoteTree.constructor)();
    SyncService.localHashCache = {};
    SyncService.isSyncing = false;

    // Must re-apply all mock implementations after clearAllMocks
    jest.clearAllMocks();

    const FileSystem = require('expo-file-system');
    FileSystem.getInfoAsync.mockResolvedValue({ exists: false });
    FileSystem.writeAsStringAsync.mockResolvedValue();
    FileSystem.makeDirectoryAsync.mockResolvedValue();
    FileSystem.readAsStringAsync.mockResolvedValue('{}');

    const Crypto = require('expo-crypto');
    Crypto.digestStringAsync.mockImplementation((algo, str) =>
      Promise.resolve(cryptoMock(str))
    );
  });

  test('buildLocalTree creates correct hierarchy', async () => {
    const root = await SyncService.buildLocalTree(mockAssets);

    expect(root.children.length).toBe(1); // Year 2024
    expect(root.children[0].id).toBe(2024);

    const year2024 = root.children[0];
    expect(year2024.children.length).toBe(2); // Jan and Feb

    const jan = year2024.getChild(1);
    expect(jan.children.length).toBe(1); // Day 1

    const day1 = jan.getChild(1);
    expect(day1.children.length).toBe(2); // 2 assets on Jan 1
  });

  test('localTree.findDiff identifies missing remote assets (upload)', async () => {
    // Build local tree with h1, h2, h3
    const localTree = await SyncService.buildLocalTree(mockAssets);
    await localTree.updateHash();

    // Build a remote tree with ONLY h1 and h2 (h3 is missing on remote)
    const RemoteTreeClass = localTree.constructor;
    const remoteTree = new RemoteTreeClass();
    remoteTree.addAsset(2024, 1, 1, 'h1', '1', new Date('2024-01-01T12:00:00Z'));
    remoteTree.addAsset(2024, 1, 1, 'h2', '2', new Date('2024-01-01T13:00:00Z'));
    await remoteTree.updateHash();

    const diff = localTree.findDiff(remoteTree);

    expect(diff.uploadAssets.length).toBe(1);
    expect(diff.uploadAssets[0].hash).toBe('h3');
  });

  test('localTree.findDiff identifies missing local assets (download)', async () => {
    // Build local tree with h1, h2, h3
    const localTree = await SyncService.buildLocalTree(mockAssets);
    await localTree.updateHash();

    // Build a remote tree with h1, h2, h3 AND an extra h4
    const RemoteTreeClass = localTree.constructor;
    const remoteTree = new RemoteTreeClass();
    remoteTree.addAsset(2024, 1, 1, 'h1', '1', new Date('2024-01-01T12:00:00Z'));
    remoteTree.addAsset(2024, 1, 1, 'h2', '2', new Date('2024-01-01T13:00:00Z'));
    remoteTree.addAsset(2024, 2, 1, 'h3', '3', new Date('2024-02-01T12:00:00Z'));
    remoteTree.addAsset(2024, 3, 1, 'h4', '4', new Date('2024-03-01T12:00:00Z'));
    await remoteTree.updateHash();

    const diff = localTree.findDiff(remoteTree);

    expect(diff.downloadAssets.length).toBe(1);
    expect(diff.downloadAssets[0].hash).toBe('h4');
  });
});
