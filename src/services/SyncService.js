import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import axios from 'axios';
import AuthService from './AuthService';
import MediaService from './MediaService';
import AssetDBService from './AssetDBService';
import MetricsTracker from '../utils/MetricsTracker';
import * as SecureStore from 'expo-secure-store';

/**
 * Parses a date string from the backend and ensures it's treated as UTC.
 * Backend dates (e.g. "2024-03-16 08:23:26") often lack the 'Z' suffix.
 */
const parseBackendDate = (dateStr) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  
  let normalized = dateStr.trim();
  // Check if it already has UTC indicator (Z) or an offset (+HH:mm or -HH:mm at the end)
  // We avoid a simple .includes('-') because date separators use dashes.
  const hasTimeZone = /Z$|[+-]\d{2}(?::?\d{2})?$/.test(normalized);
  
  if (!hasTimeZone) {
    // Replace space with T for valid ISO format if needed and force UTC
    normalized = normalized.replace(' ', 'T') + 'Z';
  }
  
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
};



class MerkleNode {
  constructor(id = null, hash = null) {
    this.id = id;
    this.hash = hash;
    this.tag = null;
    this.date = null;
    this.children = []; // nodeListOrdered in Swift
    this.parentNode = null;
  }

  setTag(tag) {
    this.tag = tag;
  }

  setDate(date) {
    this.date = date;
  }

  setHash(id, hash) {
    if (this.id === null) {
      this.id = id;
    }
    if (hash !== null) {
      this.hash = hash;
    }
  }

  addChild(child) {
    child.parentNode = this;
    // Keep children ordered by ID (default for Year/Month/Day)
    const index = this.children.findIndex(c => c.id > child.id);
    if (index === -1) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  getChild(id) {
    return this.children.find(c => c.id === id);
  }

  async updateHash() {
    if (this.children.length > 0) {
      // Recursively update children first
      for (const child of this.children) {
        await child.updateHash();
      }

      // Day nodes children (Assets) are sorted by Val (Hash) in Swift
      // For ID-indexed levels, we sort by ID. For Asset level, we sort by Hash.
      const isLevelAsset = this.children[0]?.tag !== null;
      const sorted = [...this.children].sort((a, b) => {
        if (isLevelAsset) return a.hash < b.hash ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });

      let concatHashStr = "";
      for (const child of sorted) {
        if (child.hash) {
          concatHashStr += child.hash;
        }
      }
      
      if (concatHashStr) {
        this.hash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA1,
          concatHashStr
        );
      }
    }
    return this.hash;
  }

  /**
   * Serializes the node for caching
   */
  toJSON() {
    return {
      id: this.id,
      hash: this.hash,
      tag: this.tag,
      date: this.date,
      children: this.children.map(c => c.toJSON())
    };
  }

  /**
   * Compares two lists of nodes and returns (upload, download, pending).
   * Defined on MerkleNode so it's callable on any level node (year, month, day).
   */
  compareNodeList(localNodes, remoteNodes, compareKey = 'id') {
    const upload = [];
    const download = [];
    const pending = [];

    const localSorted = [...localNodes].sort((a, b) => (a[compareKey] < b[compareKey] ? -1 : 1));
    const remoteSorted = [...remoteNodes].sort((a, b) => (a[compareKey] < b[compareKey] ? -1 : 1));

    let i = 0, j = 0;
    while (i < localSorted.length && j < remoteSorted.length) {
      const local = localSorted[i];
      const remote = remoteSorted[j];

      if (local[compareKey] < remote[compareKey]) {
        upload.push(local);
        i++;
      } else if (local[compareKey] > remote[compareKey]) {
        download.push(remote);
        j++;
      } else {
        const localHash = local.hash?.toLowerCase();
        const remoteHash = remote.hash?.toLowerCase();
        // If either hash is missing or they differ, treat as pending (needs drill-down)
        if (!localHash || !remoteHash || localHash !== remoteHash) {
          pending.push({ local, remote });
        }
        i++;
        j++;
      }
    }

    while (i < localSorted.length) upload.push(localSorted[i++]);
    while (j < remoteSorted.length) download.push(remoteSorted[j++]);

    return { upload, download, pending };
  }

  /**
   * Deserializes from cache
   */
  static fromJSON(data) {
    const node = new MerkleNode(data.id, data.hash);
    node.tag = data.tag;
    node.date = parseBackendDate(data.date);
    if (data.children) {
      node.children = data.children.map(c => {
        const child = MerkleNode.fromJSON(c);
        child.parentNode = node;
        return child;
      });
    }
    return node;
  }

  /**
   * Deserializes from cache asynchronously to prevent blocking the JS thread (ANR).
   * Yields control back to the event loop every 1000 nodes.
   */
  static async fromJSONAsync(data, yieldCounterRef = { count: 0 }) {
    yieldCounterRef.count++;
    if (yieldCounterRef.count % 1000 === 0) {
      // Yield to JS event loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const node = new MerkleNode(data.id, data.hash);
    node.tag = data.tag;
    node.date = parseBackendDate(data.date);
    if (data.children) {
      const children = [];
      for (const c of data.children) {
        const child = await MerkleNode.fromJSONAsync(c, yieldCounterRef);
        child.parentNode = node;
        children.push(child);
      }
      node.children = children;
    }
    return node;
  }
}

class AssetMerkleRoot extends MerkleNode {
  constructor() {
    super('root', null);
    this.assetsMap = new Map();
  }

  // Hierarchical addition: Year -> Month -> Day -> Asset
  addAsset(year, month, day, assetHash, assetId, date) {
    const normalizedHash = assetHash.toLowerCase();

    // Fast O(1) duplicate check across the entire tree
    let assetNode = this.assetsMap.get(normalizedHash);
    if (assetNode) return assetNode;

    const yearNode = this.getChild(year) || this.addChild(new MerkleNode(year, null));
    const monthNode = yearNode.getChild(month) || yearNode.addChild(new MerkleNode(month, null));
    const dayNode = monthNode.getChild(day) || monthNode.addChild(new MerkleNode(day, null));

    assetNode = new MerkleNode(day, normalizedHash);
    assetNode.setTag(assetId);
    assetNode.setDate(date);
    
    dayNode.children.push(assetNode); // O(1) push instead of O(N) splice
    assetNode.parentNode = dayNode;
    this.assetsMap.set(normalizedHash, assetNode);
    
    return assetNode;
  }

  getNodeByHash(hash) {
    if (!hash) return null;
    return this.assetsMap.get(hash.toLowerCase());
  }

  updateAssetsMap() {
    this.assetsMap.clear();
    this._traverseAndMap(this);
  }

  _traverseAndMap(node) {
    if (node.tag) {
      this.assetsMap.set(node.hash.toLowerCase(), node);
      return;
    }
    node.children.forEach(c => this._traverseAndMap(c));
  }

  static fromJSON(data) {
    const root = new AssetMerkleRoot();
    root.id = data.id;
    root.hash = data.hash;
    if (data.children) {
      root.children = data.children.map(c => {
        const child = MerkleNode.fromJSON(c);
        child.parentNode = root;
        return child;
      });
    }
    root.updateAssetsMap();
    return root;
  }

  static async fromJSONAsync(data) {
    const root = new AssetMerkleRoot();
    root.id = data.id;
    root.hash = data.hash;

    const yieldCounterRef = { count: 0 };
    if (data.children) {
      const children = [];
      for (const c of data.children) {
        const child = await MerkleNode.fromJSONAsync(c, yieldCounterRef);
        child.parentNode = root;
        children.push(child);
      }
      root.children = children;
    }
    root.updateAssetsMap();
    return root;
  }


  findDiff(otherTree) {
    const uploadAssets = [];
    const downloadAssets = [];

    const yearDiff = this.compareNodeList(this.children, otherTree.children, 'id');
    
    yearDiff.upload.forEach(yearNode => this._collectAssets(yearNode, uploadAssets));
    yearDiff.download.forEach(yearNode => this._collectAssets(yearNode, downloadAssets));

    yearDiff.pending.forEach(({ local, remote }) => {
      const monthDiff = this.compareNodeList(local.children, remote.children, 'id');
      
      monthDiff.upload.forEach(node => this._collectAssets(node, uploadAssets));
      monthDiff.download.forEach(node => this._collectAssets(node, downloadAssets));

      monthDiff.pending.forEach(({ local: lMonth, remote: rMonth }) => {
        const dayDiff = this.compareNodeList(lMonth.children, rMonth.children, 'id');

        dayDiff.upload.forEach(node => this._collectAssets(node, uploadAssets));
        dayDiff.download.forEach(node => this._collectAssets(node, downloadAssets));

        dayDiff.pending.forEach(({ local: lDay, remote: rDay }) => {
          const assetDiff = this.compareNodeList(lDay.children, rDay.children, 'hash');
          assetDiff.upload.forEach(node => uploadAssets.push(node));
          assetDiff.download.forEach(node => downloadAssets.push(node));
        });
      });
    });

    return { uploadAssets, downloadAssets };
  }

  _collectAssets(node, list) {
    if (node.tag) {
      list.push(node);
      return;
    }
    node.children.forEach(child => this._collectAssets(child, list));
  }
}

class SyncService {
  constructor() {
    this.localTree = new AssetMerkleRoot();
    this.remoteTree = new AssetMerkleRoot();
    this.localHashCache = {};
    this.isSyncing = false;
  }

  async clearCache() {
    await this.clearLocalHashCache();
    await this.clearRemoteTreeCache();
  }

  async clearLocalHashCache() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return;
    try {
      const path = `${cacheDir}local_hash_cache_v2.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        await FileSystem.deleteAsync(path);
        console.log('[SyncService] Legacy local hash cache JSON cleared');
      }
      
      // Also clear DB hashes for local assets
      await AssetDBService.init();
      if (AssetDBService.db) {
        await AssetDBService.db.runAsync('UPDATE MediaAsset SET hash = NULL, hashModificationTime = NULL WHERE isLocal = 1');
        console.log('[SyncService] SQLite local hash cache cleared');
      }
      this.localHashCache = {};
    } catch (e) {
      console.error('[SyncService] Failed to clear local hash cache', e);
    }
  }

  async loadLocalHashCache() {
    await AssetDBService.init();
    this.localHashCache = await AssetDBService.getLocalHashesMap();
  }

  async saveLocalHashCache() {
    // Deprecated: No-op. Persisting is now done incrementally via AssetDBService.updateAssetHash
  }

  async clearRemoteTreeCache() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return;
    try {
      const path = `${cacheDir}remote_tree_v2.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        await FileSystem.deleteAsync(path);
        console.log('[SyncService] Remote tree cache cleared');
      }
      this.remoteTree = new AssetMerkleRoot();
    } catch (e) {
      console.error('[SyncService] Failed to clear remote tree cache', e);
    }
  }

  async getCacheStats() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return { local: 0, remote: 0 };
    
    const stats = { local: 0, remote: 0 };
    try {
      const localInfo = await FileSystem.getInfoAsync(`${cacheDir}local_hash_cache_v2.json`);
      if (localInfo.exists) stats.local = localInfo.size;
      
      const remoteInfo = await FileSystem.getInfoAsync(`${cacheDir}remote_tree_v2.json`);
      if (remoteInfo.exists) stats.remote = remoteInfo.size;
    } catch (e) {
      console.error('[SyncService] Failed to get cache stats', e);
    }
    return stats;
  }

  async ensureCacheDir() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return false;
    try {
      const info = await FileSystem.getInfoAsync(cacheDir);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
      }
      return true;
    } catch (e) {
      console.error('[SyncService] Failed to ensure cache directory', e);
      return false;
    }
  }

  getCacheDir() {
    const docDir = FileSystem.documentDirectory;
    if (!docDir) {
      return null;
    }
    return docDir + (docDir.endsWith('/') ? '' : '/') + 'merkle/';
  }


  async precalculateHashes(assets, onProgress) {
    return await MetricsTracker.measure('SyncService_precalculateHashes', async () => {
      console.log(`Pre-calculating hashes for ${assets.length} assets...`);
      await this.loadLocalHashCache();
      const localHashMap = this.localHashCache;
      let hashedCount = 0;
      let completedCount = 0;
      let lastUiUpdateTime = Date.now();
      let lastActualUiUpdateTime = Date.now();
      
      // Reduce default concurrency to 2 to prevent starving the UI thread and JS thread.
      // 5 concurrent heavy native threads doing SHA1 + I/O causes severe UI scrolling stutter.
      let hashConcurrency = 2;
      try {
        const savedConfig = await SecureStore.getItemAsync('lomorage_hash_concurrency');
        if (savedConfig) hashConcurrency = parseInt(savedConfig, 10);
      } catch (e) {}

      let currentIndex = 0;

      const worker = async () => {
        let loops = 0;
        while (currentIndex < assets.length) {
          loops++;
          // CRITICAL FIX: Yield to the JS event loop every 50 iterations to prevent ANR
          if (loops % 50 === 0) {
              await new Promise(resolve => setTimeout(resolve, 5));
          }

          const asset = assets[currentIndex++];
          if (!asset) break;

          if (!asset.uri && !asset.localUri) {
            console.warn(`[SyncService] Asset ${asset.id} has no URI, skipping hash calculation`);
            completedCount++;
            continue;
          }
          
          let hash = asset.hash;
          if (!hash) {
            const cached = localHashMap[asset.id];
            if (cached && cached.modificationTime === asset.modificationTime) {
              hash = cached.hash;
            } else {
              try {
                let uri = asset.uri || asset.localUri;
                hash = await MediaService.calculateHash(uri, true); // silent log
                
                if (!hash) {
                  const info = await MediaService.getAssetInfo(asset.id);
                  if (info) {
                    const fallbackUri = info.uri || info.localUri;
                    if (fallbackUri) {
                      hash = await MediaService.calculateHash(fallbackUri, true);
                    }
                  }
                }
              } catch (hashError) {
                console.error(`[SyncService] Error during hash calculation for ${asset.id}:`, hashError);
              }

              if (hash) {
                const filename = asset.filename || 'unknown';
                const size = asset.mediaSubtypes?.[0] || asset.mediaType;
                localHashMap[asset.id] = {
                  hash,
                  modificationTime: asset.modificationTime
                };
                
                // Update DB incrementally
                await AssetDBService.updateAssetHash(asset.id, hash, asset.modificationTime);
              }
            }
          }
          
          if (hash) {
            hashedCount++;
            asset.hash = hash.toLowerCase(); // Persist back to asset
          }
          completedCount++;

          if (onProgress) {
            const now = Date.now();
            if (now - lastUiUpdateTime > 250 || completedCount === assets.length) {
              lastUiUpdateTime = now;
              const shouldTriggerUi = (now - lastActualUiUpdateTime > 3000) || (completedCount === assets.length);
              if (shouldTriggerUi) {
                lastActualUiUpdateTime = now;
              }
              onProgress({ 
                current: completedCount, 
                total: assets.length, 
                triggerUiUpdate: shouldTriggerUi
              });
            }
          }
        }
      };

      const workers = [];
      for (let i = 0; i < hashConcurrency; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      
      // Sync the uploaded status now that local hashes are assigned
      await AssetDBService.syncUploadedStatus();
      // Reload cache to give fast UI access to the new 'uploaded' flags
      await this.loadLocalHashCache();
      
      console.log(`[SyncService] Pre-calculated hashes for ${hashedCount}/${assets.length} assets`);
    });
  }

  async buildLocalTree(assets, onProgress) {
    return await MetricsTracker.measure('SyncService_buildLocalTree', async () => {
      console.log(`Building local Merkle Tree for ${assets.length} assets...`);
      const root = new AssetMerkleRoot();
      
      await this.loadLocalHashCache();
      const localHashMap = this.localHashCache;
      let hashedCount = 0;
      
      for (let i = 0; i < assets.length; i++) {
        // Yield to the JS event loop every 500 iterations to prevent blocking during tree construction
        if (i % 500 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const asset = assets[i];
        let hash = asset.hash;
        
        if (!hash) {
          const cached = localHashMap[asset.id];
          if (cached && cached.modificationTime === asset.modificationTime) {
            hash = cached.hash;
          }
        }

        if (hash) {
          hashedCount++;
          const lowerHash = hash.toLowerCase();
          asset.hash = lowerHash;
          
          const time = asset.creationTime || asset.modificationTime || Date.now();
          const date = new Date(time);
          const year = date.getUTCFullYear();
          const month = date.getUTCMonth() + 1;
          const day = date.getUTCDate();
          
          root.addAsset(year, month, day, lowerHash, asset.id, date);
        }
      }
      
      console.log(`[SyncService] Built local tree with ${hashedCount}/${assets.length} hashed assets`);
      await root.updateHash();
      this.localTree = root;
      return root;
    });
  }

  async saveRemoteTree() {
    if (!(await this.ensureCacheDir())) return;
    const cacheDir = this.getCacheDir();

    try {
      console.log('[SyncService] Saving remote tree: checking info');
      const info = await FileSystem.getInfoAsync(cacheDir);
      if (!info.exists) {
        console.log('[SyncService] Saving remote tree: creating directory');
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
      }
      console.log('[SyncService] Saving remote tree: serializing');
      const jsonData = this.remoteTree.toJSON();
      const data = JSON.stringify(jsonData);
      console.log(`[SyncService] Saving remote tree: writing ${data.length} bytes`);
      await FileSystem.writeAsStringAsync(`${cacheDir}remote_tree_v2.json`, data);
      console.log('[SyncService] Saving remote tree: success');
    } catch (e) {
      console.error('[SyncService] Failed to save remote tree error:', e);
      if (e instanceof Error) {
        console.error('[SyncService] Error message:', e.message);
        console.error('[SyncService] Stack trace:', e.stack);
      }
    }
  }

  async loadRemoteTree() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return false;

    try {
      const path = `${cacheDir}remote_tree_v2.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        const data = await FileSystem.readAsStringAsync(path);
        this.remoteTree = await AssetMerkleRoot.fromJSONAsync(JSON.parse(data));

        // Trigger background migration & healing asynchronously so we don't block
        this._migrateAndHealRemoteAssets().catch(err => {
          console.error('[SyncService] Failed to migrate/heal remote assets:', err);
        });

        return true;
      }
    } catch (e) {
      console.error('Failed to load remote tree', e);
    }
    return false;
  }

  async _migrateAndHealRemoteAssets() {
    if (!this.remoteTree) return;
    
    await AssetDBService.init();
    const sqlCount = await AssetDBService.getRemoteAssetsCount();
    const treeAssets = Array.from(this.remoteTree.assetsMap.values());

    console.log(`[SyncService] _migrateAndHealRemoteAssets: SQLite remote count=${sqlCount}, MerkleTree assets=${treeAssets.length}`);

    // Case 1: JSON to SQLite migration
    if (sqlCount === 0 && treeAssets.length > 0) {
      console.log('[SyncService] Migrating remote assets from JSON cache to SQLite...');
      await AssetDBService.syncRemoteAssets(treeAssets);
      console.log('[SyncService] JSON to SQLite migration completed.');
      
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('remoteAssetsUpdated');
      return;
    }

    // Case 2: Heal missing filenames in existing SQLite database
    if (sqlCount > 0 && treeAssets.length > 0) {
      const db = AssetDBService.db;
      if (!db) return;
      
      try {
        const nullRows = await db.getAllAsync(
          `SELECT id, hash FROM MediaAsset WHERE isLocal = 0 AND filename IS NULL`
        );
        
        if (nullRows && nullRows.length > 0) {
          console.log(`[SyncService] Found ${nullRows.length} legacy remote assets with NULL filenames in SQLite. Healing...`);
          const updates = [];
          
          const isVideoExtension = (filename) => {
            if (!filename) return false;
            const ext = filename.split('.').pop().toLowerCase();
            return ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext);
          };

          for (const row of nullRows) {
            const node = this.remoteTree.getNodeByHash(row.hash);
            if (node) {
              const filename = node.tag || '';
              const mediaType = isVideoExtension(filename) ? 'video' : 'photo';
              updates.push({
                hash: row.hash,
                filename,
                mediaType
              });
            }
          }
          
          if (updates.length > 0) {
            await AssetDBService.updateRemoteAssetFilenames(updates);
            console.log(`[SyncService] Successfully healed ${updates.length} assets.`);
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('remoteAssetsUpdated');
          }
        }
      } catch (e) {
        console.error('[SyncService] Error during auto-healing:', e);
      }
    }
  }

  /**
   * Fetches month-level Merkle tree from the server (no individual asset details).
   * This is a lightweight call that returns: { Hash, Years: [{ Year, Hash, Months: [{ Month, Hash }] }] }
   * Used for incremental updates: compare month hashes against cache to find changed months.
   */
  async fetchRemoteMonthLevel() {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      // Without ?all=1, the backend returns only year/month level with hashes (no day/asset details)
        const response = await axios.get(`${url}/assets/merkletree`, {
          headers: { Authorization: `token=${token}` },
          timeout: 30000,
          skipAutoProbe: true,
          priority: 4,
          groupId: 'SyncService'
        });
      return response.data;
    } catch (e) {
      console.error('[SyncService] Failed to fetch month-level tree', e);
      if (e.response && e.response.status === 401) {
        const authError = new Error('Your session has expired. Please log out and log in again.');
        authError.isAuthError = true;
        throw authError;
      }
      const netError = new Error('Could not reach server. Check your connection and try again.');
      netError.isNetworkError = true;
      throw netError;
    }
  }

  /**
   * Retrieves and caches a pre-sorted array of remote assets mapped to UI format.
   * Eliminates O(N log N) sorting overhead from the UI thread.
   */
  getSortedRemoteAssets() {
    if (this._sortedRemoteAssetsCache) return this._sortedRemoteAssetsCache;
    
    const remoteAssets = Array.from(this.remoteTree?.assetsMap?.values() || []);
    const isVideoExtension = (filename) => {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext);
    };
    
    this._sortedRemoteAssetsCache = remoteAssets.map(remote => ({
        id: remote.hash,
        uri: remote.tag,
        hash: remote.hash,
        status: 'remote',
        mediaType: isVideoExtension(remote.tag) ? 'video' : 'photo',
        creationTime: remote.date ? remote.date.getTime() : 0,
    })).sort((a, b) => b.creationTime - a.creationTime);
    
    return this._sortedRemoteAssetsCache;
  }

  /**
   * Incrementally updates the remote Merkle tree.
   * Strategy (matching iOS lomo-ios/AssetSync.swift):
   * 1. Fetch month-level hashes (lightweight, no individual assets)
   * 2. Compare each month's hash against cached tree
   * 3. Only fetch asset-level details for CHANGED months
   * 4. Reuse cached subtrees for UNCHANGED months
   * 
   * On first run (empty cache), this falls back to fetching all months.
   */
  async fetchRemoteOverview() {
    this._sortedRemoteAssetsCache = null; // Invalidate cache before updating tree
    return await MetricsTracker.measure('SyncService_fetchRemoteOverview', async () => {
      // Lazy-load remote tree cache from disk if it hasn't been loaded into memory yet
      if (!this.remoteTree) {
        console.log('[SyncService] Lazy-loading remote tree cache...');
        await this.loadRemoteTree();
      }

      const url = AuthService.getServerUrl();
      const token = AuthService.getToken();
      if (!url || !token) return null;

      try {
        // Step 1: Fetch month-level tree (small payload)
        const monthLevelData = await this.fetchRemoteMonthLevel();
        if (!monthLevelData) return this.remoteTree;

        // Quick check: if root hash hasn't changed, skip everything
        if (this.remoteTree && this.remoteTree.hash &&
            monthLevelData.Hash === this.remoteTree.hash) {
          console.log('[SyncService] Remote tree unchanged (root hash match), skipping update');
          return this.remoteTree;
        }

        // Step 2: Build new tree, reusing cached subtrees for unchanged months
        const newRoot = new AssetMerkleRoot();
        newRoot.hash = monthLevelData.Hash;
        const cachedTree = this.remoteTree; // reference to current cache
        const changedMonths = []; // months that need asset-level fetch

        if (monthLevelData.Years) {
          for (const y of monthLevelData.Years) {
            const yearNode = newRoot.addChild(new MerkleNode(y.Year, y.Hash));
            
            if (y.Months) {
              for (const m of y.Months) {
                // Check if this month exists in cache with same hash
                const cachedYear = cachedTree?.getChild(y.Year);
                const cachedMonth = cachedYear?.getChild(m.Month);
                
                if (cachedMonth && cachedMonth.hash === m.Hash && cachedMonth.children.length > 0) {
                  // UNCHANGED: reuse entire cached subtree (days + assets)
                  const reusedMonth = new MerkleNode(m.Month, m.Hash);
                  // Deep copy children from cache and re-parent them
                  for (const cachedDay of cachedMonth.children) {
                    const dayClone = this._cloneSubtree(cachedDay);
                    reusedMonth.addChild(dayClone);
                  }
                  yearNode.addChild(reusedMonth);
                  console.log(`[SyncService] Reusing cached month ${y.Year}/${m.Month} (hash match)`);
                } else {
                  // CHANGED or NEW: add placeholder, will fetch details
                  const monthNode = yearNode.addChild(new MerkleNode(m.Month, m.Hash));
                  changedMonths.push({ year: y.Year, month: m.Month, node: monthNode });
                }
              }
            }
          }
        }

        console.log(`[SyncService] Incremental update: ${changedMonths.length} changed months to fetch`);

        // Step 3: Fetch asset-level details concurrently for all changed months
        // Batched to 3 at a time to prevent flooding the JS networking bridge with 100+ concurrent requests
        const fetchedResults = [];
        const batchSize = 3;
        for (let i = 0; i < changedMonths.length; i += batchSize) {
          const batch = changedMonths.slice(i, i + batchSize);
          const fetchPromises = batch.map(async ({ year, month, node }) => {
            try {
              const monthData = await this.fetchRemoteMonth(year, month);
              return { year, month, node, monthData };
            } catch (monthErr) {
              console.warn(`[SyncService] Failed to fetch month ${year}/${month}:`, monthErr.message);
              return { year, month, node, monthData: null, isError: true };
            }
          });
          const batchResults = await Promise.all(fetchPromises);
          fetchedResults.push(...batchResults);
          
          // Yield after each batch to keep UI smooth
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        let yieldCounter = 0;

        for (const { year, month, node, monthData } of fetchedResults) {
          if (monthData && monthData.Days) {
            for (const d of monthData.Days) {
              const dayNode = node.addChild(new MerkleNode(d.Day, d.Hash));
              if (d.Assets) {
                for (const a of d.Assets) {
                  yieldCounter++;
                  if (yieldCounter % 500 === 0) {
                    // Yield back to the JS event loop to keep the UI responsive during tree building
                    await new Promise(resolve => setTimeout(resolve, 5));
                  }

                  const lowerHash = a.Hash.toLowerCase();
                  // Duplicate check within tree
                  if (!newRoot.getNodeByHash(lowerHash)) {
                    const assetNode = new MerkleNode(d.Day, lowerHash);
                    assetNode.setTag(a.Name);
                    if (a.Date) assetNode.setDate(parseBackendDate(a.Date));
                    dayNode.children.push(assetNode);
                    assetNode.parentNode = dayNode;
                    newRoot.assetsMap.set(lowerHash, assetNode);
                  }
                }
              }
            }
          } else {
            // Fallback to cached data if the response is invalid or request failed
            console.log(`[SyncService] Falling back to cached data for ${year}/${month} (Failed/Empty fetch)`);
            const cachedYear = cachedTree?.getChild(year);
            const cachedMonth = cachedYear?.getChild(month);
            if (cachedMonth && cachedMonth.children.length > 0) {
              for (const cachedDay of cachedMonth.children) {
                const dayClone = this._cloneSubtree(cachedDay);
                node.addChild(dayClone);
              }
            }
          }
        }

        // Step 4: Rebuild assets map and save
        newRoot.updateAssetsMap();
        this.remoteTree = newRoot;
        await this.saveRemoteTree();

        // Insert into local SQLite cache for Photo Map and Gallery Grid
        await AssetDBService.init();
        const remoteAssets = Array.from(newRoot.assetsMap.values());
        await AssetDBService.syncRemoteAssets(remoteAssets);
        // Sync the DB uploaded status
        await AssetDBService.syncUploadedStatus();
        await this.loadLocalHashCache();

        // Emit event so the HomeScreen updates the gallery grid
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('remoteAssetsUpdated');

        // Trigger background GPS sync
        this.syncRemoteGPS().catch(e => console.error('[SyncService] background remote GPS sync error:', e));
        this.syncLocalGPS().catch(e => console.error('[SyncService] background local GPS sync error:', e));

        return newRoot;
      } catch (e) {
        console.error('Failed to fetch remote overview', e);
        if (e.response && e.response.status === 401) {
          const authError = new Error('Your session has expired. Please log out and log in again.');
          authError.isAuthError = true;
          throw authError;
        }
        if (e.isAuthError || e.isNetworkError) throw e;
        const netError = new Error('Could not reach server. Check your connection and try again.');
        netError.isNetworkError = true;
        throw netError;
      }
    });
  }

  /**
   * Deep clones a MerkleNode subtree for reuse in a new tree.
   * This is needed because nodes have parentNode references that need to be re-wired.
   */
  _cloneSubtree(node) {
    const clone = new MerkleNode(node.id, node.hash);
    clone.tag = node.tag;
    clone.date = node.date;
    for (const child of node.children) {
      const childClone = this._cloneSubtree(child);
      clone.addChild(childClone);
    }
    return clone;
  }

  async fetchRemoteMonth(year, month) {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      const response = await axios.get(`${url}/assets/merkletree/${year}/${month}?all=1`, {
        headers: { Authorization: `token=${token}` },
        timeout: 60000,
        skipAutoProbe: true,
        priority: 4,
        groupId: 'SyncService'
      });
      return response.data; // { Month: X, Hash: "...", Days: [...] }
    } catch (e) {
      console.error(`Failed to fetch remote month ${year}/${month}`, e);
      return null;
    }
  }

  async syncRemoteGPS() {
    return await MetricsTracker.measure('SyncService_syncRemoteGPS', async () => {
      if (this._isSyncingGPS) {
        console.log('[SyncService] syncRemoteGPS: already running, skipping.');
        return;
      }
      this._isSyncingGPS = true;
      console.log('[SyncService] syncRemoteGPS started.');
      try {
        const url = AuthService.getServerUrl();
        const token = AuthService.getToken();
        if (!url || !token) {
          console.log('[SyncService] syncRemoteGPS aborted: server url or token is missing.');
          return;
        }

        while (true) {
          const pending = await AssetDBService.getRemoteAssetsWithoutGeo(50);
          console.log(`[SyncService] syncRemoteGPS: retrieved ${pending ? pending.length : 0} pending assets without geo.`);
          if (!pending || pending.length === 0) break;

          const updates = [];
          const noGeoIds = [];

          // Batch requests with simple Promise.all
          const promises = pending.map(async (asset) => {
            try {
              const res = await axios.get(`${url}/asset/metadata/${asset.hash}`, {
                headers: { Authorization: `token=${token}` },
                timeout: 10000,
                skipAutoProbe: true,
                priority: 4,
                groupId: 'SyncService'
              });
              const data = res.data;
              if (data && (data.Latitude !== 0 || data.Longitude !== 0)) {
                updates.push({
                  id: asset.id,
                  latitude: data.Latitude,
                  longitude: data.Longitude
                });
              } else {
                noGeoIds.push(asset.id);
              }
            } catch (e) {
              if (e.response && e.response.status === 404) {
                noGeoIds.push(asset.id);
              } else {
                console.warn(`[SyncService] Failed to fetch GPS for ${asset.hash}:`, e.message);
              }
            }
          });

          await Promise.all(promises);

          console.log(`[SyncService] syncRemoteGPS batch done: updates count = ${updates.length}, noGeo count = ${noGeoIds.length}`);

          if (updates.length > 0) {
            await AssetDBService.updateAssetsGeo(updates);
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('remoteAssetsUpdated');
          }
          if (noGeoIds.length > 0) {
            await AssetDBService.markAssetsGeoProcessed(noGeoIds);
          }
        }
      } finally {
        this._isSyncingGPS = false;
        console.log('[SyncService] syncRemoteGPS finished.');
      }
    });
  }

  async syncLocalGPS() {
    return await MetricsTracker.measure('SyncService_syncLocalGPS', async () => {
      if (this._isSyncingLocalGPS) {
        console.log('[SyncService] syncLocalGPS: already running, skipping.');
        return;
      }
      this._isSyncingLocalGPS = true;
      console.log('[SyncService] syncLocalGPS started.');
      try {
        while (true) {
          const pending = await AssetDBService.getLocalAssetsWithoutGeo(50);
          console.log(`[SyncService] syncLocalGPS: retrieved ${pending ? pending.length : 0} pending assets without geo.`);
          if (!pending || pending.length === 0) break;

          const updates = [];
          const noGeoIds = [];

          // Batch requests with Promise.all
          const promises = pending.map(async (asset) => {
            try {
              const info = await MediaService.getAssetInfo(asset.id);
              if (info && info.location && info.location.latitude && info.location.longitude) {
                updates.push({
                  id: asset.id,
                  latitude: info.location.latitude,
                  longitude: info.location.longitude
                });
              } else {
                noGeoIds.push(asset.id);
              }
            } catch (e) {
              console.warn(`[SyncService] Failed to extract local GPS for ${asset.id}:`, e.message);
              noGeoIds.push(asset.id); // mark processed anyway to avoid retry loop
            }
          });

          await Promise.all(promises);

          console.log(`[SyncService] syncLocalGPS batch done: updates count = ${updates.length}, noGeo count = ${noGeoIds.length}`);

          if (updates.length > 0) {
            await AssetDBService.updateAssetsGeo(updates);
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('remoteAssetsUpdated');
          }
          if (noGeoIds.length > 0) {
            await AssetDBService.markAssetsGeoProcessed(noGeoIds);
          }

          // yield to event loop briefly
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally {
        this._isSyncingLocalGPS = false;
        console.log('[SyncService] syncLocalGPS finished.');
      }
    });
  }
  async fetchRemoteDay(year, month, day) {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      const response = await axios.get(`${url}/assets/merkletree/${year}/${month}/${day}`, {
        headers: { Authorization: `token=${token}` },
        timeout: 60000,
        skipAutoProbe: true,
        priority: 4,
        groupId: 'SyncService'
      });
      return response.data; // { Day: X, Hash: "...", Assets: [...] }
    } catch (e) {
      console.error(`Failed to fetch remote day ${year}/${month}/${day}`, e);
      return null;
    }
  }

  async removeRemoteAsset(hash) {
    if (!hash) return;
    const normalizedHash = hash.toLowerCase();
    const node = this.remoteTree.getNodeByHash(normalizedHash);
    if (node) {
      const parent = node.parentNode;
      if (parent) {
        parent.children = parent.children.filter(c => c.hash !== normalizedHash);
      }
      this.remoteTree.assetsMap.delete(normalizedHash);
      // We don't strictly need to recalculate all parent hashes here because
      // fetchRemoteOverview will eventually replace the whole tree,
      // but we do need to save the updated JSON so relaunch doesn't show it.
      await this.saveRemoteTree();
      console.log(`[SyncService] Removed ${normalizedHash} from remote tree cache`);
    }
  }

  /**
   * Performs full synchronization logic:
   * 1. Build local tree
   * 2. Fetch remote overview
   * 3. Drill down incrementally where hashes differ
   * 4. Return full diff
   */
  async sync(localAssets, onProgress) {
    if (this.isSyncing) return null;
    this.isSyncing = true;
    
    try {
      if (onProgress) onProgress({ current: 0, total: localAssets.length });
      await this.precalculateHashes(localAssets, onProgress);

      await this.buildLocalTree(localAssets, onProgress);
      
      const remoteOverview = await this.fetchRemoteOverview();

      const uploadAssets = [];
      const downloadAssets = [];

      await this.findDiffWithDrillDown(this.localTree, this.remoteTree, uploadAssets, downloadAssets, 'year');
      
      if (onProgress) onProgress({ current: localAssets.length, total: localAssets.length });
      return { uploadAssets, downloadAssets };
    } finally {
      this.isSyncing = false;
      try {
        const AIService = require('./AIService').default;
        (async () => {
          await AIService.processLocalEmbeddings(30);
          await AIService.syncEmbeddings();
        })().catch(err => {
          console.warn('[SyncService] Background AI processing/sync failed:', err.message);
        });
      } catch (e) {
        console.warn('[SyncService] Failed to load AIService:', e.message);
      }
    }
  }

  async findDiffWithDrillDown(localNode, remoteNode, upload, download, level, ctx = { networkError: false, yieldCount: 0 }) {
    if (!localNode || !remoteNode) return;
    // Short-circuit: stop all further fetching if a network error occurred in this sync pass
    if (ctx.networkError) return;

    ctx.yieldCount = (ctx.yieldCount || 0) + 1;
    if (ctx.yieldCount % 200 === 0) {
      // Yield to event loop every 200 nodes compared/visited
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const diff = localNode.compareNodeList(localNode.children, remoteNode.children, level === 'asset' ? 'hash' : 'id');

    // 1. New local assets -> Upload
    for (const node of diff.upload) {
      const potentials = [];
      this.localTree._collectAssets(node, potentials);
      for (const asset of potentials) {
        ctx.yieldCount++;
        if (ctx.yieldCount % 500 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        // Double-check global existence to prevent phantom uploads from bucket mismatches
        if (!this.remoteTree.getNodeByHash(asset.hash)) {
          upload.push(asset);
        }
      }
    }

    // 2. New remote assets -> Download
    for (const node of diff.download) {
      if (ctx.networkError) break; // Stop iterating if server went offline mid-sync
      if (level === 'day' && !node.tag && node.children.length === 0) {
        // We found a day that exists on remote but we don't have detail yet
        const year = localNode.parentNode.id;
        const month = localNode.id;
        const day = node.id;
        const detail = await this.fetchRemoteDay(year, month, day);
        if (detail === null) {
          console.warn(`[SyncService] Network error fetching day ${year}/${month}/${day}. Stopping drill-down.`);
          ctx.networkError = true;
          break;
        }
        if (detail && detail.Assets) {
          for (const a of detail.Assets) {
            const assetNode = this.remoteTree.addAsset(year, month, day, a.Hash, a.Name, parseBackendDate(a.Date));
            // Global check for downloads
            if (!this.localTree.getNodeByHash(assetNode.hash)) {
              download.push(assetNode);
            }
          }
        }
      } else {
        const potentials = [];
        this.remoteTree._collectAssets(node, potentials);
        for (const assetNode of potentials) {
          ctx.yieldCount++;
          if (ctx.yieldCount % 500 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (!this.localTree.getNodeByHash(assetNode.hash)) {
            download.push(assetNode);
          }
        }
      }
    }

    // 3. Changed nodes -> Drill down
    for (const { local, remote } of diff.pending) {
      if (ctx.networkError) break; // Stop iterating on error
      if (level === 'year') {
        await this.findDiffWithDrillDown(local, remote, upload, download, 'month', ctx);
      } else if (level === 'month') {
        await this.findDiffWithDrillDown(local, remote, upload, download, 'day', ctx);
      } else if (level === 'day') {
        // At day level, pending means asset list differs
        // If remote day has no children, fetch them
        if (remote.children.length === 0) {
          const year = local.parentNode.parentNode.id;
          const month = local.parentNode.id;
          const day = local.id;
          const detail = await this.fetchRemoteDay(year, month, day);
          if (detail === null) {
            console.warn(`[SyncService] Network error fetching day ${year}/${month}/${day}. Stopping drill-down.`);
            ctx.networkError = true;
            break;
          }
          if (detail && detail.Assets) {
            for (const a of detail.Assets) {
              this.remoteTree.addAsset(year, month, day, a.Hash, a.Name, parseBackendDate(a.Date));
            }
          }
        }
        
        const assetDiff = local.compareNodeList(local.children, remote.children, 'hash');
        assetDiff.upload.forEach(n => upload.push(n));
        assetDiff.download.forEach(n => download.push(n));
      }
    }
  }


  getDiff() {
    if (!this.localTree || !this.remoteTree) return { uploadAssets: [], downloadAssets: [] };
    return this.localTree.findDiff(this.remoteTree);
  }
}

export default new SyncService();
