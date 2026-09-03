// Clusters phash-tagged assets into near-duplicate groups (Hamming distance <= 6),
// then builds display-ready group objects sorted local-first, newest-first.
//
// This used to live inline as AIService.findDuplicateGroups's body. As a method on
// that ~3500-line class, its compiled release-bundle output was hitting a Metro/
// terser minification bug: the closure variable holding the async-generator
// implementation ended up unassigned, so calling the method threw "undefined is
// not a function" in release builds only (dev bundles, which skip that minifier
// pass, worked fine). Moving the algorithm into its own small module sidesteps
// whatever compiled shape triggered it.
export async function clusterDuplicateAssets(assets, getPreviewUrl) {
  // 1.5 Deduplicate local/remote synced pairs by Hash
  const uniqueByHash = new Map();
  for (const a of assets) {
    if (a.hash && uniqueByHash.has(a.hash)) {
      // Prefer local asset if both exist
      if (a.isLocal === 1) {
        uniqueByHash.set(a.hash, a);
      }
    } else if (a.hash) {
      uniqueByHash.set(a.hash, a);
    } else {
      // No hash, just use ID
      uniqueByHash.set(a.id, a);
    }
  }
  const deduplicatedAssets = Array.from(uniqueByHash.values());
  console.log(`[AIService] Hash deduplication completed. Unique assets by hash: ${deduplicatedAssets.length}`);

  // 2. Parse phash into BigInts and Pre-group identical exact matches
  const exactGroupsMap = new Map();
  for (const a of deduplicatedAssets) {
    try {
      if (a.phash) {
        const phashBig = BigInt(a.phash);
        const pLow = Number(phashBig & 0xffffffffn) | 0;
        const pHigh = Number((phashBig >> 32n) & 0xffffffffn) | 0;
        if (!exactGroupsMap.has(a.phash)) {
          exactGroupsMap.set(a.phash, { pLow, pHigh, items: [] });
        }
        exactGroupsMap.get(a.phash).items.push({ ...a });
      }
    } catch (e) {
      console.warn(`[AIService] Invalid phash BigInt for asset ${a.id}:`, a.phash);
    }
  }

  const uniquePhashGroups = Array.from(exactGroupsMap.values());
  console.log(`[AIService] Exact phash grouping completed. Unique phash groups: ${uniquePhashGroups.length}`);
  if (uniquePhashGroups.length === 0) return [];

  // 3. Fast popcount helper for 32-bit ints
  // (Hamming distance of 64-bit BigInts computed as two 32-bit halves in ~50ns)

  // 4. Greedy clustering loop (Hamming distance <= 6)
  const clusters = [];
  const visited = new Set();
  const clusteringStart = Date.now();

  const len = uniquePhashGroups.length;
  const pLowArr = new Int32Array(len);
  const pHighArr = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    pLowArr[i] = uniquePhashGroups[i].pLow;
    pHighArr[i] = uniquePhashGroups[i].pHigh;
  }

  for (let i = 0; i < len; i++) {
    // Yield to event loop to prevent UI freezing
    if (i > 0 && i % 500 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const groupA = uniquePhashGroups[i];
    const representativeId = groupA.items[0].id;

    if (visited.has(representativeId)) continue;

    let cluster = [...groupA.items];
    const pLowA = pLowArr[i];
    const pHighA = pHighArr[i];

    for (let j = i + 1; j < len; j++) {
      let vLow = pLowA ^ pLowArr[j];
      vLow = vLow - ((vLow >>> 1) & 0x55555555);
      vLow = (vLow & 0x33333333) + ((vLow >>> 2) & 0x33333333);
      const cLow = (((vLow + (vLow >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;

      if (cLow > 6) continue;

      let vHigh = pHighA ^ pHighArr[j];
      vHigh = vHigh - ((vHigh >>> 1) & 0x55555555);
      vHigh = (vHigh & 0x33333333) + ((vHigh >>> 2) & 0x33333333);
      const cHigh = (((vHigh + (vHigh >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;

      if (cLow + cHigh <= 6) {
        const groupB = uniquePhashGroups[j];
        const repBId = groupB.items[0].id;
        if (visited.has(repBId)) continue;

        cluster = cluster.concat(groupB.items);
        visited.add(repBId);
      }
    }

    if (cluster.length > 1) {
      visited.add(representativeId);
      clusters.push(cluster);
    }
  }
  console.log(`[AIService] greedy_clustering: ${Date.now() - clusteringStart}ms`);
  console.log(`[AIService] Greedy clustering completed. Clusters found: ${clusters.length}`);

  // 5. Build result clusters - use data already in SQLite, skip expensive network/filesystem calls.
  // Sort heuristic: prefer local assets (isLocal=1) over remote, then newer createTime first.
  // This avoids hundreds of MediaService.getAssetInfo / axios.head calls that were causing the long wait.
  const enrichedClusters = clusters.map(cluster => {
    const sorted = [...cluster].sort((a, b) => {
      // Local beats remote
      const localDiff = (b.isLocal === 1 ? 1 : 0) - (a.isLocal === 1 ? 1 : 0);
      if (localDiff !== 0) return localDiff;
      // Newer createTime first
      return (b.createTime || 0) - (a.createTime || 0);
    });

    const filteredCluster = [];
    const seenIds = new Set();
    for (const asset of sorted) {
      if (!seenIds.has(asset.id)) {
        seenIds.add(asset.id);
        filteredCluster.push(asset);
      }
    }

    return filteredCluster.map(asset => {
      let displayUri = null;
      if (asset.isLocal === 1) {
        // Will be resolved lazily by the UI when the user views the asset
        displayUri = null;
      } else if (asset.localCachePath && asset.mediaType !== 'video') {
        displayUri = asset.localCachePath;
      } else {
        displayUri = getPreviewUrl(asset.hash);
      }
      return {
        id: asset.id,
        hash: asset.hash,
        isLocal: asset.isLocal === 1,
        filename: asset.filename,
        createTime: asset.createTime,
        mediaType: asset.mediaType,
        width: 0,
        height: 0,
        size: 0,
        displayUri,
        qualityScore: 0
      };
    });
  });

  // Filter out clusters that have less than 2 items after deduplication
  return enrichedClusters.filter(c => c.length > 1);
}
