// A fake camera roll. Tests put fixture files into it with
// integration/support/cameraRoll.js; services read it through the normal
// expo-media-library calls.
const fs = require('fs');

const assets = new Map();

const MediaType = { audio: 'audio', photo: 'photo', video: 'video', unknown: 'unknown' };
const SortBy = { default: 'default', creationTime: 'creationTime', modificationTime: 'modificationTime' };

const granted = { granted: true, status: 'granted', canAskAgain: true, accessPrivileges: 'all' };

function sorted() {
  return [...assets.values()].sort((a, b) => b.creationTime - a.creationTime);
}

async function getAssetsAsync({ first = 50, after, mediaType } = {}) {
  const types = mediaType ? [].concat(mediaType) : null;
  const all = sorted().filter((a) => !types || types.includes(a.mediaType));
  const start = after ? all.findIndex((a) => a.id === after) + 1 : 0;
  const page = all.slice(start, start + first);
  return {
    assets: page,
    endCursor: page.length ? page[page.length - 1].id : after,
    hasNextPage: start + first < all.length,
    totalCount: all.length,
  };
}

async function getAssetInfoAsync(assetOrId) {
  const id = typeof assetOrId === 'string' ? assetOrId : assetOrId.id;
  const asset = assets.get(id);
  if (!asset) throw new Error(`Asset ${id} not found`);
  return { ...asset, localUri: asset.uri };
}

async function deleteAssetsAsync(assetsOrIds) {
  for (const a of [].concat(assetsOrIds)) {
    const id = typeof a === 'string' ? a : a.id;
    const asset = assets.get(id);
    if (asset) fs.rmSync(require('./sandbox').toPath(asset.uri), { force: true });
    assets.delete(id);
  }
  return true;
}

module.exports = {
  MediaType,
  SortBy,
  deleteAssetsAsync,
  getAssetInfoAsync,
  getAssetsAsync,
  getPermissionsAsync: async () => granted,
  requestPermissionsAsync: async () => granted,
  __assets: assets,
};
