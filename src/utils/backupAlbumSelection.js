// Selective Backup lists phone albums and stores the ones to skip.
// "Back up these" / "Skip these" apply to the albums on screen, so a search
// for "screenshot" can turn that whole group off without flipping every other album.

export function filterAlbums(albums, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return albums;
  return albums.filter((album) => (album.title || '').toLowerCase().includes(q));
}

export function sortAlbums(albums, sort) {
  const copy = [...albums];
  const byName = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
  if (sort === 'name') {
    copy.sort(byName);
  } else if (sort === 'countAsc') {
    copy.sort((a, b) => (a.assetCount || 0) - (b.assetCount || 0) || byName(a, b));
  } else {
    copy.sort((a, b) => (b.assetCount || 0) - (a.assetCount || 0) || byName(a, b));
  }
  return copy;
}

// include true: these albums get backed up (drop them from the skip list).
// include false: these albums are skipped (add them). Albums not in visibleIds stay as they were.
export function applyAlbumInclusion(excludedIds, visibleIds, include) {
  const visible = new Set(visibleIds);
  if (include) return excludedIds.filter((id) => !visible.has(id));
  const next = new Set(excludedIds);
  for (const id of visibleIds) next.add(id);
  return [...next];
}
