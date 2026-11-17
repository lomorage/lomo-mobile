import { cosineSimilarity } from './vectorMath';

export const DEFAULT_FACE_MATCH_THRESHOLD = 0.30;

// Ranks every album in faceAlbumCache (each expected to have `id`, optionally
// `title`, and `coverEmbedding`) against faceVector by cosine similarity,
// descending. Albums without a coverEmbedding are skipped. `bestMatch` is the
// top-ranked entry if its similarity clears `threshold`, otherwise null.
export function rankFaceAlbumMatches(faceVector, faceAlbumCache, threshold = DEFAULT_FACE_MATCH_THRESHOLD) {
  const allMatches = [];
  for (const album of faceAlbumCache || []) {
    if (album.coverEmbedding) {
      const similarity = cosineSimilarity(faceVector, album.coverEmbedding);
      allMatches.push({ id: album.id, title: album.title, similarity });
    }
  }
  allMatches.sort((a, b) => b.similarity - a.similarity);
  const bestMatch = (allMatches.length > 0 && allMatches[0].similarity > threshold) ? allMatches[0] : null;
  return { bestMatch, allMatches };
}

// Albums whose cover embeddings clear the same threshold as a photo match are
// the same person split across two albums. Returns each such group (length >= 2).
// Albums with no cover embedding are left out: nothing proves they match.
export function groupDuplicateFaceAlbums(faceAlbumCache, threshold = DEFAULT_FACE_MATCH_THRESHOLD) {
  const albums = (faceAlbumCache || []).filter(album => album && album.coverEmbedding);
  const parent = albums.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < albums.length; i++) {
    for (let j = i + 1; j < albums.length; j++) {
      const similarity = cosineSimilarity(albums[i].coverEmbedding, albums[j].coverEmbedding);
      if (similarity > threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  albums.forEach((album, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(album);
  });
  return [...groups.values()].filter(group => group.length >= 2);
}

// The server keeps the album with the most photos, then renames that survivor
// to the Title we send. group[0] is list order (title sort), so an unamed
// album can sort ahead of the populated one and rename it.
export function titleForFaceAlbumMerge(group) {
  let best = null;
  for (const album of group || []) {
    const title = album && album.title;
    if (!title || !title.startsWith('/Faces/')) continue;
    const count = Number(album.count) || 0;
    const unamed = title.includes('/unamed-');
    if (!best || count > best.count || (count === best.count && best.unamed && !unamed)) {
      best = { title, count, unamed };
    }
  }
  if (!best || best.count <= 0) return null;
  return best.title;
}
