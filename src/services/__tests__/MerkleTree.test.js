/**
 * MerkleTree.test.js
 * 
 * Comprehensive unit tests for MerkleNode and AssetMerkleRoot classes
 * defined in SyncService.js.
 * 
 * Coverage:
 *  - MerkleNode: construction, addChild (ordering), getChild, setTag/setDate,
 *    updateHash (leaf, internal, recursive), compareNodeList (upload/download/pending),
 *    toJSON / fromJSON serialization round-trip
 *  - AssetMerkleRoot: addAsset (hierarchy creation, dedup), getNodeByHash,
 *    updateAssetsMap, findDiff (upload / download / both / identical trees),
 *    _collectAssets
 */

// Pull out internals via the module — SyncService exports a singleton,
// but we need the classes themselves. We extract them from the module's scope
// by testing through the exported SyncService API (buildLocalTree, localTree).
import SyncService from '../SyncService';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../MediaService', () => ({
  calculateHash: jest.fn(() => Promise.resolve(null)),
  getAssetInfo: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///mock/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue('{}'),
}));

// SyncService also imports the old expo-file-system for its cache
jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue('{}'),
}));

jest.mock('../AuthService', () => ({
  getServerUrl: () => 'http://localhost:8000',
  getToken: () => 'mock-token',
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn((_, str) => Promise.resolve(`sha1(${str})`)),
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the AssetMerkleRoot class from a live tree instance */
const getTreeClass = () => SyncService.localTree.constructor;

/** Create a fresh, empty AssetMerkleRoot */
const newTree = () => new (getTreeClass())();

beforeEach(() => {
  SyncService.localTree = newTree();
  SyncService.remoteTree = newTree();
  SyncService.localHashCache = {};
  SyncService.isSyncing = false;
  jest.clearAllMocks();

  const Crypto = require('expo-crypto');
  Crypto.digestStringAsync.mockImplementation((_, str) => Promise.resolve(`sha1(${str})`));
  const FileSystem = require('expo-file-system');
  FileSystem.getInfoAsync.mockResolvedValue({ exists: false });
  FileSystem.writeAsStringAsync.mockResolvedValue();
});

// ─── MerkleNode: basics ───────────────────────────────────────────────────────

describe('MerkleNode — basics', () => {
  test('addChild inserts in sorted order by id', () => {
    const tree = newTree();
    // Add years out of order
    tree.addAsset(2023, 1, 1, 'hash_a', 'a1', new Date('2023-01-01'));
    tree.addAsset(2025, 1, 1, 'hash_c', 'c1', new Date('2025-01-01'));
    tree.addAsset(2024, 1, 1, 'hash_b', 'b1', new Date('2024-01-01'));

    expect(tree.children.map(c => c.id)).toEqual([2023, 2024, 2025]);
  });

  test('getChild finds by id', () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));

    const year = tree.getChild(2024);
    expect(year).not.toBeNull();
    expect(year.id).toBe(2024);

    expect(tree.getChild(9999)).toBeUndefined();
  });

  test('setTag and setDate are stored on the node', () => {
    const tree = newTree();
    const assetNode = tree.addAsset(2024, 1, 1, 'h1', 'my-tag', new Date('2024-01-01'));
    expect(assetNode.tag).toBe('my-tag');
    expect(assetNode.date).toBeInstanceOf(Date);
  });
});

// ─── MerkleNode: updateHash ───────────────────────────────────────────────────

describe('MerkleNode — updateHash', () => {
  test('leaf node (asset) keeps its hash unchanged by updateHash', async () => {
    const tree = newTree();
    const assetNode = tree.addAsset(2024, 1, 1, 'abc123', 'id1', new Date('2024-01-01'));
    const hashBefore = assetNode.hash;
    await assetNode.updateHash(); // no children → does nothing
    expect(assetNode.hash).toBe(hashBefore);
  });

  test('day node computes hash from concatenated sorted child hashes', async () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'zzz', 'id1', new Date('2024-01-01'));
    tree.addAsset(2024, 1, 1, 'aaa', 'id2', new Date('2024-01-01'));

    const day = tree.getChild(2024).getChild(1).getChild(1);
    await day.updateHash();

    // Assets are sorted by hash value: 'aaa' before 'zzz'
    expect(require('expo-crypto').digestStringAsync)
      .toHaveBeenCalledWith('SHA-1', 'aaazzz');
  });

  test('updateHash sets a non-null hash on a tree root after full build', async () => {
    // buildLocalTree calls updateHash after adding all assets
    const assets = [
      { id: '1', hash: 'h1', uri: 'file:///a.jpg', localUri: 'file:///a.jpg',
        creationTime: new Date('2024-06-15T00:00:00Z').getTime(), modificationTime: 1 }
    ];
    const root = await SyncService.buildLocalTree(assets);
    // buildLocalTree calls updateHash internally — root hash should be set
    expect(root.hash).toBeTruthy();
    expect(typeof root.hash).toBe('string');
  });

  test('two identical trees produce the same root hash', async () => {
    const treeA = newTree();
    treeA.addAsset(2024, 1, 1, 'hash1', 'id1', new Date('2024-01-01'));
    treeA.addAsset(2024, 2, 5, 'hash2', 'id2', new Date('2024-02-05'));
    await treeA.updateHash();

    const treeB = newTree();
    treeB.addAsset(2024, 1, 1, 'hash1', 'id1', new Date('2024-01-01'));
    treeB.addAsset(2024, 2, 5, 'hash2', 'id2', new Date('2024-02-05'));
    await treeB.updateHash();

    expect(treeA.hash).toBe(treeB.hash);
  });

  test('two different asset sets produce different hashes', async () => {
    // Use buildLocalTree because it calls updateHash on all levels bottom-up
    const assetsA = [
      { id: '1', hash: 'hash1', uri: 'f', localUri: 'f',
        creationTime: new Date('2024-01-01').getTime(), modificationTime: 1 }
    ];
    const assetsB = [
      { id: '1', hash: 'hash_DIFFERENT', uri: 'f', localUri: 'f',
        creationTime: new Date('2024-01-01').getTime(), modificationTime: 1 }
    ];

    SyncService.localHashCache = {};
    SyncService.isSyncing = false;
    const rootA = await SyncService.buildLocalTree(assetsA);

    SyncService.localTree = newTree();
    SyncService.localHashCache = {};
    SyncService.isSyncing = false;
    const rootB = await SyncService.buildLocalTree(assetsB);

    expect(rootA.hash).not.toBe(rootB.hash);
  });

});

// ─── MerkleNode: compareNodeList ─────────────────────────────────────────────

describe('MerkleNode — compareNodeList', () => {
  const node = (id, hash) => ({ id, hash });

  test('all local → all upload when remote is empty', () => {
    const tree = newTree();
    const result = tree.compareNodeList([node(1, 'h1'), node(2, 'h2')], [], 'id');
    expect(result.upload.map(n => n.id)).toEqual([1, 2]);
    expect(result.download).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
  });

  test('all remote → all download when local is empty', () => {
    const tree = newTree();
    const result = tree.compareNodeList([], [node(3, 'h3'), node(4, 'h4')], 'id');
    expect(result.download.map(n => n.id)).toEqual([3, 4]);
    expect(result.upload).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
  });

  test('matching ids with same hash → no diff', () => {
    const tree = newTree();
    const result = tree.compareNodeList(
      [node(1, 'abc'), node(2, 'def')],
      [node(1, 'abc'), node(2, 'def')],
      'id'
    );
    expect(result.upload).toHaveLength(0);
    expect(result.download).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
  });

  test('matching ids with different hash → pending (drill-down needed)', () => {
    const tree = newTree();
    const result = tree.compareNodeList(
      [node(2024, 'local_hash')],
      [node(2024, 'remote_hash')],
      'id'
    );
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].local.hash).toBe('local_hash');
    expect(result.pending[0].remote.hash).toBe('remote_hash');
  });

  test('hash comparison is case-insensitive', () => {
    const tree = newTree();
    // Same hash, different case — should NOT be pending
    const result = tree.compareNodeList(
      [node(1, 'AABBCC')],
      [node(1, 'aabbcc')],
      'id'
    );
    expect(result.pending).toHaveLength(0);
  });

  test('null hash on either side → pending (conservative)', () => {
    const tree = newTree();
    const result = tree.compareNodeList(
      [{ id: 1, hash: null }],
      [{ id: 1, hash: 'somehash' }],
      'id'
    );
    expect(result.pending).toHaveLength(1);
  });

  test('mixed case: upload + download + pending', () => {
    const tree = newTree();
    const result = tree.compareNodeList(
      [node(2022, 'h_2022'), node(2023, 'local_2023'), node(2024, 'h_2024')],
      [node(2021, 'h_2021'), node(2023, 'remote_2023'), node(2024, 'h_2024')],
      'id'
    );
    expect(result.upload.map(n => n.id)).toEqual([2022]);    // only local
    expect(result.download.map(n => n.id)).toEqual([2021]);  // only remote
    expect(result.pending).toHaveLength(1);                  // 2023 differs
  });
});

// ─── MerkleNode: toJSON / fromJSON ───────────────────────────────────────────

describe('MerkleNode — serialization (toJSON / fromJSON)', () => {
  test('toJSON captures all fields', () => {
    const tree = newTree();
    tree.addAsset(2024, 3, 10, 'myhash', 'asset-1', new Date('2024-03-10'));

    const json = tree.toJSON();
    expect(json.id).toBe('root');
    expect(json.children).toHaveLength(1); // year 2024
    expect(json.children[0].id).toBe(2024);
  });

  test('fromJSON reconstructs the tree with same structure', () => {
    const original = newTree();
    original.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    original.addAsset(2024, 2, 5, 'h2', 'id2', new Date('2024-02-05'));

    const TreeClass = getTreeClass();
    const restored = TreeClass.fromJSON(original.toJSON());

    expect(restored.children.length).toBe(original.children.length);
    expect(restored.getChild(2024)).not.toBeUndefined();
    expect(restored.getChild(2024).getChild(1)).not.toBeUndefined();
  });

  test('fromJSON round-trip preserves asset hashes and tags', () => {
    const original = newTree();
    original.addAsset(2024, 6, 15, 'deadbeef', 'my-file.jpg', new Date('2024-06-15'));

    const TreeClass = getTreeClass();
    const restored = TreeClass.fromJSON(original.toJSON());

    const assetNode = restored.getChild(2024).getChild(6).getChild(15).children[0];
    expect(assetNode.hash).toBe('deadbeef');
    expect(assetNode.tag).toBe('my-file.jpg');
  });
});

// ─── AssetMerkleRoot: addAsset ────────────────────────────────────────────────

describe('AssetMerkleRoot — addAsset', () => {
  test('creates year → month → day → asset hierarchy', () => {
    const tree = newTree();
    tree.addAsset(2024, 7, 20, 'h1', 'id1', new Date('2024-07-20'));

    const year = tree.getChild(2024);
    expect(year).toBeDefined();
    const month = year.getChild(7);
    expect(month).toBeDefined();
    const day = month.getChild(20);
    expect(day).toBeDefined();
    expect(day.children).toHaveLength(1);
  });

  test('adding same hash twice does not duplicate', () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'SAME_HASH', 'id1', new Date('2024-01-01'));
    tree.addAsset(2024, 1, 1, 'same_hash', 'id2', new Date('2024-01-01')); // same, different case
    const day = tree.getChild(2024).getChild(1).getChild(1);
    expect(day.children).toHaveLength(1);
  });

  test('asset hashes are stored lower-case', () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'UPPERCASE_HASH', 'id1', new Date('2024-01-01'));
    const asset = tree.getChild(2024).getChild(1).getChild(1).children[0];
    expect(asset.hash).toBe('uppercase_hash');
  });

  test('assets within a day are sorted by hash', () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'zzz', 'id3', new Date('2024-01-01'));
    tree.addAsset(2024, 1, 1, 'aaa', 'id1', new Date('2024-01-01'));
    tree.addAsset(2024, 1, 1, 'mmm', 'id2', new Date('2024-01-01'));

    const day = tree.getChild(2024).getChild(1).getChild(1);
    expect(day.children.map(c => c.hash)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  test('addAsset updates assetsMap', () => {
    const tree = newTree();
    tree.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    expect(tree.getNodeByHash('h1')).not.toBeNull();
    expect(tree.getNodeByHash('H1')).not.toBeNull(); // case-insensitive lookup
  });
});

// ─── AssetMerkleRoot: findDiff ────────────────────────────────────────────────

describe('AssetMerkleRoot — findDiff', () => {
  test('identical trees → no upload, no download', async () => {
    const local = newTree();
    local.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    local.addAsset(2024, 2, 5, 'h2', 'id2', new Date('2024-02-05'));
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    remote.addAsset(2024, 2, 5, 'h2', 'id2', new Date('2024-02-05'));
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.uploadAssets).toHaveLength(0);
    expect(diff.downloadAssets).toHaveLength(0);
  });

  test('local has extra asset → appears in uploadAssets', async () => {
    const local = newTree();
    local.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    local.addAsset(2024, 1, 1, 'h2', 'id2', new Date('2024-01-01'));
    local.addAsset(2024, 3, 1, 'h3', 'id3', new Date('2024-03-01')); // only local
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    remote.addAsset(2024, 1, 1, 'h2', 'id2', new Date('2024-01-01'));
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.uploadAssets).toHaveLength(1);
    expect(diff.uploadAssets[0].hash).toBe('h3');
    expect(diff.downloadAssets).toHaveLength(0);
  });

  test('remote has extra asset → appears in downloadAssets', async () => {
    const local = newTree();
    local.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 1, 1, 'h1', 'id1', new Date('2024-01-01'));
    remote.addAsset(2024, 5, 10, 'h_remote', 'id2', new Date('2024-05-10')); // only remote
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.downloadAssets).toHaveLength(1);
    expect(diff.downloadAssets[0].hash).toBe('h_remote');
    expect(diff.uploadAssets).toHaveLength(0);
  });

  test('both sides have unique assets → upload and download', async () => {
    const local = newTree();
    local.addAsset(2024, 1, 1, 'local_only', 'id1', new Date('2024-01-01'));
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 6, 1, 'remote_only', 'id2', new Date('2024-06-01'));
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.uploadAssets).toHaveLength(1);
    expect(diff.uploadAssets[0].hash).toBe('local_only');
    expect(diff.downloadAssets).toHaveLength(1);
    expect(diff.downloadAssets[0].hash).toBe('remote_only');
  });

  test('empty local vs populated remote → all download', async () => {
    const local = newTree();
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 1, 1, 'r1', 'id1', new Date('2024-01-01'));
    remote.addAsset(2024, 1, 1, 'r2', 'id2', new Date('2024-01-01'));
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.downloadAssets).toHaveLength(2);
    expect(diff.uploadAssets).toHaveLength(0);
  });

  test('populated local vs empty remote → all upload', async () => {
    const local = newTree();
    local.addAsset(2024, 1, 1, 'l1', 'id1', new Date('2024-01-01'));
    local.addAsset(2024, 2, 1, 'l2', 'id2', new Date('2024-02-01'));
    await local.updateHash();

    const remote = newTree();
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.uploadAssets).toHaveLength(2);
    expect(diff.downloadAssets).toHaveLength(0);
  });

  test('different assets in same day → correct upload and download', async () => {
    const local = newTree();
    local.addAsset(2024, 4, 20, 'l_asset', 'idL', new Date('2024-04-20'));
    await local.updateHash();

    const remote = newTree();
    remote.addAsset(2024, 4, 20, 'r_asset', 'idR', new Date('2024-04-20'));
    await remote.updateHash();

    const diff = local.findDiff(remote);
    expect(diff.uploadAssets).toHaveLength(1);
    expect(diff.uploadAssets[0].hash).toBe('l_asset');
    expect(diff.downloadAssets).toHaveLength(1);
    expect(diff.downloadAssets[0].hash).toBe('r_asset');
  });
});

// ─── buildLocalTree integration ───────────────────────────────────────────────

describe('SyncService.buildLocalTree', () => {
  beforeEach(() => {
    // Re-apply the FileSystem mock after clearAllMocks
    const FileSystem = require('expo-file-system');
    FileSystem.getInfoAsync.mockResolvedValue({ exists: false });
  });

  const assets = [
    { id: '10', hash: 'ha', uri: 'file:///a.jpg', localUri: 'file:///a.jpg', creationTime: new Date('2023-05-01T00:00:00Z').getTime(), modificationTime: 100 },
    { id: '11', hash: 'hb', uri: 'file:///b.jpg', localUri: 'file:///b.jpg', creationTime: new Date('2023-05-01T00:00:00Z').getTime(), modificationTime: 200 },
    { id: '12', hash: 'hc', uri: 'file:///c.jpg', localUri: 'file:///c.jpg', creationTime: new Date('2023-12-25T00:00:00Z').getTime(), modificationTime: 300 },
  ];

  test('correctly groups assets by year/month/day', async () => {
    const root = await SyncService.buildLocalTree(assets);

    const year2023 = root.getChild(2023);
    expect(year2023).toBeDefined();

    const may = year2023.getChild(5);
    const dec = year2023.getChild(12);
    expect(may).toBeDefined();
    expect(dec).toBeDefined();

    expect(may.getChild(1).children).toHaveLength(2); // ha, hb on May 1
    expect(dec.getChild(25).children).toHaveLength(1); // hc on Dec 25
  });

  test('assets with pre-existing hashes skip calculateHash', async () => {
    const MediaService = require('../MediaService');
    await SyncService.buildLocalTree(assets);
    expect(MediaService.calculateHash).not.toHaveBeenCalled();
  });

  test('persists hash back to asset.hash field (lowercase)', async () => {
    const testAssets = [
      { id: '99', hash: 'UPPER', uri: 'file:///x.jpg', localUri: 'file:///x.jpg', creationTime: new Date('2024-06-01').getTime(), modificationTime: 1 }
    ];
    await SyncService.buildLocalTree(testAssets);
    expect(testAssets[0].hash).toBe('upper');
  });
});
