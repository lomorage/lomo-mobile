import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import axios from 'axios';
import MediaService from './MediaService';
import AuthService from './AuthService';

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
}

class AssetMerkleRoot extends MerkleNode {
  constructor() {
    super('root', null);
    this.assetsMap = new Map();
  }

  // Hierarchical addition: Year -> Month -> Day -> Asset
  addAsset(year, month, day, assetHash, assetId, date) {
    let yearNode = this.getChild(year);
    if (!yearNode) {
      yearNode = this.addChild(new MerkleNode(year));
    }

    let monthNode = yearNode.getChild(month);
    if (!monthNode) {
      monthNode = yearNode.addChild(new MerkleNode(month));
    }

    let dayNode = monthNode.getChild(day);
    if (!dayNode) {
      dayNode = monthNode.addChild(new MerkleNode(day));
    }

    const normalizedHash = assetHash.toLowerCase();
    let assetNode = dayNode.children.find(c => c.hash.toLowerCase() === normalizedHash);
    if (!assetNode) {
      assetNode = new MerkleNode(day, normalizedHash);
      assetNode.setTag(assetId);
      assetNode.setDate(date);
      
      const index = dayNode.children.findIndex(c => c.hash.toLowerCase() > normalizedHash);
      if (index === -1) {
        dayNode.children.push(assetNode);
      } else {
        dayNode.children.splice(index, 0, assetNode);
      }
      assetNode.parentNode = dayNode;
      this.assetsMap.set(normalizedHash, assetNode);
    }
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
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return;
    try {
      const info = await FileSystem.getInfoAsync(cacheDir);
      if (info.exists) {
        await FileSystem.deleteAsync(cacheDir);
        console.log('[SyncService] Merkle cache directory cleared');
      }
      this.localTree = new AssetMerkleRoot();
      this.remoteTree = new AssetMerkleRoot();
      this.localHashCache = {};
    } catch (e) {
      console.error('[SyncService] Failed to clear cache', e);
    }
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

  async loadLocalHashCache() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return;
    try {
      const path = `${cacheDir}local_hash_cache_v2.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        const data = await FileSystem.readAsStringAsync(path);
        this.localHashCache = JSON.parse(data);
      } else {
        this.localHashCache = {};
      }
    } catch (e) {
      console.warn('Failed to load local hash cache', e);
      this.localHashCache = {};
    }
  }

  async saveLocalHashCache() {
    const cacheDir = this.getCacheDir();
    if (!cacheDir) return;

    if (!(await this.ensureCacheDir())) return;

    // Await to avoid concurrent writes to the same JSON file
    // which can corrupt the file in Expo FileSystem
    try {
      const path = `${cacheDir}local_hash_cache_v2.json`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(this.localHashCache));
    } catch (e) {
      console.warn('Failed to save local hash cache', e);
    }
  }

  async buildLocalTree(assets, onProgress) {
    console.log(`Building local Merkle Tree for ${assets.length} assets...`);
    const root = new AssetMerkleRoot();
    
    await this.loadLocalHashCache();
    let cacheUpdated = false;
    let hashedCount = 0;
    let lastUiUpdateTime = Date.now();
    
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];

      if (!asset.uri && !asset.localUri) {
        console.warn(`[SyncService] Asset ${asset.id} has no URI, skipping hash calculation`);
        continue;
      }

      const date = new Date(asset.creationTime);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      
      let hash = asset.hash;
      if (!hash) {
        const cached = this.localHashCache[asset.id];
        if (cached && cached.modificationTime === asset.modificationTime) {
          hash = cached.hash;
        } else {
          try {
            // Prefer the original content:// URI (asset.uri on Android). 
            // Our native hasher calls MediaStore.setRequireOriginal() on content:// URIs,
            // which bypasses Android's EXIF byte redaction and reads the original file.
            // Fall back to file:// localUri if asset.uri is missing.
            let uri = asset.uri || asset.localUri;
            console.log(`[SyncService] Hashing asset ${asset.id} (${asset.filename}) via URI: ${uri}`);
            hash = await MediaService.calculateHash(uri);
            
            if (!hash) {
              // Fallback: try file:// path from full asset info
              console.log(`[SyncService] Hash attempt 1 failed for ${asset.id}, resolving full asset info...`);
              const info = await MediaService.getAssetInfo(asset.id);
              if (info) {
                const fallbackUri = info.uri || info.localUri;
                if (fallbackUri) {
                  console.log(`[SyncService] Fallback URI for ${asset.id}: ${fallbackUri}`);
                  hash = await MediaService.calculateHash(fallbackUri);
                }
              }
            }
          } catch (hashError) {
            console.error(`[SyncService] Error during hash calculation for ${asset.id}:`, hashError);
          }

          
          if (hash) {
            this.localHashCache[asset.id] = {
              hash,
              modificationTime: asset.modificationTime,
              // Add human-readable metadata for debugging
              filename: asset.filename || 'unknown',
              size: asset.mediaSubtypes?.[0] || asset.mediaType // Expo doesn't provide size natively in getAssetsAsync, but this helps
            };
            cacheUpdated = true;
          }
        }
      }
      
      if (hash) {
        hashedCount++;
        const lowerHash = hash.toLowerCase();
        asset.hash = lowerHash; // Persist hash back to asset object for deduplication in UI
        root.addAsset(year, month, day, lowerHash, asset.id, date);
        
        // Save cache periodically so we don't start from scratch if app restarts
        if (hashedCount % 20 === 0 && cacheUpdated) {
          await this.saveLocalHashCache(); // Await to prevent Expo FS race conditions
          cacheUpdated = false;
        }
      } else {
        // Log skip without being too spammy if it's many assets
        if (hashedCount % 100 === 0) {
          console.log(`[SyncService] No hash for asset ${asset.id} yet, count: ${hashedCount}`);
        }
      }

      if (onProgress) {
        const now = Date.now();
        if (now - lastUiUpdateTime > 250 || i === assets.length - 1) {
          lastUiUpdateTime = now;
          onProgress({ 
            current: i + 1, 
            total: assets.length, 
            message: `Hashing local assets...`,
            triggerUiUpdate: true 
          });
        }
      }
    }
    
    if (cacheUpdated) {
      this.saveLocalHashCache(); // Don't block on saving cache
    }
    
    console.log(`[SyncService] Built local tree with ${hashedCount}/${assets.length} hashed assets`);
    await root.updateHash();
    this.localTree = root;
    return root;
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
        this.remoteTree = AssetMerkleRoot.fromJSON(JSON.parse(data));
        return true;
      }
    } catch (e) {
      console.error('Failed to load remote tree', e);
    }
    return false;
  }

  async fetchRemoteOverview() {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      const response = await axios.get(`${url}/assets/merkletree?all=1`, {
        headers: { Authorization: `token=${token}` },
        timeout: 10000
      });
      
      const remoteRoot = new AssetMerkleRoot();
      remoteRoot.hash = response.data.Hash;
      
      if (response.data.Years) {
        for (const y of response.data.Years) {
          const yearNode = remoteRoot.addChild(new MerkleNode(y.Year, y.Hash));
          if (y.Months) {
            for (const m of y.Months) {
              const monthNode = yearNode.addChild(new MerkleNode(m.Month, m.Hash));
              if (m.Days) {
                for (const d of m.Days) {
                  const dayNode = monthNode.addChild(new MerkleNode(d.Day, d.Hash));
                      if (d.Assets) {
                        for (const a of d.Assets) {
                          const lowerHash = a.Hash.toLowerCase();
                          // Duplicate check within remote tree itself
                          if (!remoteRoot.getNodeByHash(lowerHash)) {
                            const assetNode = new MerkleNode(d.Day, lowerHash);
                            assetNode.setTag(a.Name);
                            if (a.Date) assetNode.setDate(parseBackendDate(a.Date));
                            dayNode.children.push(assetNode);
                            assetNode.parentNode = dayNode;
                            remoteRoot.assetsMap.set(lowerHash, assetNode);
                          }
                        }
                      }
                }
              }
            }
          }
        }
      }
      remoteRoot.updateAssetsMap();
      this.remoteTree = remoteRoot;
      await this.saveRemoteTree();
      return remoteRoot;
    } catch (e) {
      console.error('Failed to fetch remote overview', e);
      return null;
    }
  }

  async fetchRemoteMonth(year, month) {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      const response = await axios.get(`${url}/assets/merkletree/${year}/${month}`, {
        headers: { Authorization: `token=${token}` },
        timeout: 10000
      });
      return response.data; // { Month: X, Hash: "...", Days: [...] }
    } catch (e) {
      console.error(`Failed to fetch remote month ${year}/${month}`, e);
      return null;
    }
  }

  async fetchRemoteDay(year, month, day) {
    const url = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!url || !token) return null;

    try {
      const response = await axios.get(`${url}/assets/merkletree/${year}/${month}/${day}`, {
        headers: { Authorization: `token=${token}` },
        timeout: 10000
      });
      return response.data; // { Day: X, Hash: "...", Assets: [...] }
    } catch (e) {
      console.error(`Failed to fetch remote day ${year}/${month}/${day}`, e);
      return null;
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
      if (onProgress) onProgress({ message: 'Building local integrity map...' });
      await this.buildLocalTree(localAssets, onProgress);
      
      if (onProgress) onProgress({ message: 'Fetching remote asset layout...' });
      await this.fetchRemoteOverview();
      
      if (onProgress) onProgress({ message: 'Comparing local and remote assets...' });
      const uploadAssets = [];
      const downloadAssets = [];

      await this.findDiffWithDrillDown(this.localTree, this.remoteTree, uploadAssets, downloadAssets, 'year');
      
      if (onProgress) onProgress({ current: localAssets.length, total: localAssets.length, message: 'Sync complete' });
      return { uploadAssets, downloadAssets };
    } finally {
      this.isSyncing = false;
    }
  }

  async findDiffWithDrillDown(localNode, remoteNode, upload, download, level) {
    const diff = localNode.compareNodeList(localNode.children, remoteNode.children, level === 'asset' ? 'hash' : 'id');

    // 1. New local assets -> Upload
    for (const node of diff.upload) {
      this.localTree._collectAssets(node, upload);
    }

    // 2. New remote assets -> Download
    for (const node of diff.download) {
      if (level === 'day' && !node.tag) {
        // We found a day that exists on remote but we don't have detail yet
        const year = localNode.parentNode.id;
        const month = localNode.id;
        const day = node.id;
        const detail = await this.fetchRemoteDay(year, month, day);
        if (detail && detail.Assets) {
          for (const a of detail.Assets) {
            const assetNode = this.remoteTree.addAsset(year, month, day, a.Hash, a.Name, parseBackendDate(a.Date));
            download.push(assetNode);
          }
        }
      } else {
        this.remoteTree._collectAssets(node, download);
      }
    }

    // 3. Changed nodes -> Drill down
    for (const { local, remote } of diff.pending) {
      if (level === 'year') {
        await this.findDiffWithDrillDown(local, remote, upload, download, 'month');
      } else if (level === 'month') {
        await this.findDiffWithDrillDown(local, remote, upload, download, 'day');
      } else if (level === 'day') {
        // At day level, pending means asset list differs
        // If remote day has no children, fetch them
        if (remote.children.length === 0) {
          const year = local.parentNode.parentNode.id;
          const month = local.parentNode.id;
          const day = local.id;
          const detail = await this.fetchRemoteDay(year, month, day);
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
