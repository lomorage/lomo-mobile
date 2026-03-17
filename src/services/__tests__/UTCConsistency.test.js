// Mock MediaService
jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(uri => Promise.resolve('hash')),
  getAssetInfo: jest.fn(() => Promise.resolve(null)),
}));

// Mock AuthService
jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'test-token',
}));

// Mock native modules that cause issues in Jest
jest.mock('react-native-argon2', () => ({
  default: jest.fn(),
  argon2: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn((algo, str) => Promise.resolve(`digest_${str}`)),
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
}));

// Mock expo-file-system
jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/',
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
}));

// Now import the service under test
import SyncService from '../SyncService';

describe('UTC Consistency Verification', () => {
  test('parseBackendDate forces UTC on naive strings', () => {
    // We'll test it via MerkleNode.fromJSON because that's a public path that uses parseBackendDate
    // MerkleNode is defined in SyncService.js and used in fromJSON
    const root = SyncService.localTree.constructor.fromJSON({
      id: 'root',
      hash: 'h',
      children: [
        { id: 2024, hash: 'yh', date: '2024-03-16 08:00:00', tag: 'test' }
      ]
    });
    
    const node = root.children[0];
    expect(node.date).toBeDefined();
    // If parsed as UTC, getUTCHours should be 8.
    // If parsed as Local (assuming PST -7), getUTCHours would be 15.
    expect(node.date.getUTCHours()).toBe(8);
    expect(node.date.getUTCDate()).toBe(16);
  });

  test('local asset extraction uses UTC components', async () => {
    // 2024-03-16 01:00:00 UTC
    // This is 2024-03-15 late night in US timezones.
    const creationTime = new Date('2024-03-16T01:00:00Z').getTime();
    const assets = [
      { id: '1', hash: 'h1', creationTime, modificationTime: 1, uri: 'f1' }
    ];

    const root = await SyncService.buildLocalTree(assets);
    
    // Year node
    expect(root.children[0].id).toBe(2024);
    // Month node
    const yearNode = root.children[0];
    expect(yearNode.children[0].id).toBe(3);
    // Day node
    const monthNode = yearNode.children[0];
    expect(monthNode.children[0].id).toBe(16); // Must be 16, not 15.
  });
});
