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
