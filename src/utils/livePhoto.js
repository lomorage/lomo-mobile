// Determines whether an asset is a Live Photo: checks local metadata first,
// then falls back to the cached remote Merkle tree tag (for synced assets
// whose local media-library metadata isn't available). Pass in
// SyncService.remoteTree for `remoteTree`.
export function isLivePhoto(asset, remoteTree) {
  // 1. Local or synced asset with mediaSubtypes metadata
  if (asset.mediaSubtypes && (asset.mediaSubtypes.includes('livePhoto') || asset.mediaSubtypes.includes('live'))) {
    return true;
  }
  // 2. Synced local or remote asset check using filename
  if (asset.filename && asset.filename.toLowerCase().endsWith('.zip')) {
    return true;
  }
  // 3. Synced local or remote asset check using cached hash in remoteTree
  if (asset.hash) {
    const remoteNode = remoteTree?.getNodeByHash(asset.hash);
    if (remoteNode && remoteNode.tag && remoteNode.tag.toLowerCase().endsWith('.zip')) {
      return true;
    }
  }
  return false;
}
