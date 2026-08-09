import { rankFaceAlbumMatches, DEFAULT_FACE_MATCH_THRESHOLD } from '../faceAlbumMatching';

describe('rankFaceAlbumMatches', () => {
  test('returns no bestMatch and an empty list for an empty/missing cache', () => {
    expect(rankFaceAlbumMatches([1, 0], [])).toEqual({ bestMatch: null, allMatches: [] });
    expect(rankFaceAlbumMatches([1, 0], undefined)).toEqual({ bestMatch: null, allMatches: [] });
  });

  test('skips albums without a coverEmbedding', () => {
    const cache = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', coverEmbedding: [1, 0] }];
    const { allMatches } = rankFaceAlbumMatches([1, 0], cache);
    expect(allMatches).toHaveLength(1);
    expect(allMatches[0].id).toBe('b');
  });

  test('ranks matches by similarity, descending', () => {
    const cache = [
      { id: 'low', coverEmbedding: [0, 1] },      // orthogonal -> similarity 0
      { id: 'high', coverEmbedding: [1, 0] },     // identical -> similarity 1
      { id: 'mid', coverEmbedding: [1, 1] },      // ~0.707
    ];
    const { allMatches } = rankFaceAlbumMatches([1, 0], cache);
    expect(allMatches.map(m => m.id)).toEqual(['high', 'mid', 'low']);
  });

  test('bestMatch is null when the top similarity does not clear the threshold', () => {
    const cache = [{ id: 'a', coverEmbedding: [0, 1] }]; // orthogonal -> similarity 0
    const { bestMatch } = rankFaceAlbumMatches([1, 0], cache);
    expect(bestMatch).toBeNull();
  });

  test('bestMatch is the top-ranked entry when it clears the threshold', () => {
    const cache = [{ id: 'a', coverEmbedding: [1, 0] }]; // identical -> similarity 1
    const { bestMatch } = rankFaceAlbumMatches([1, 0], cache);
    expect(bestMatch).toEqual({ id: 'a', title: undefined, similarity: 1 });
  });

  test('default threshold is exclusive (0.30 itself does not count as a match)', () => {
    // Construct two vectors whose cosine similarity is exactly 0.3.
    const v1 = [1, 0];
    const v2 = [0.3, Math.sqrt(1 - 0.3 * 0.3)];
    const { bestMatch } = rankFaceAlbumMatches(v1, [{ id: 'a', coverEmbedding: v2 }]);
    expect(bestMatch).toBeNull();
    expect(DEFAULT_FACE_MATCH_THRESHOLD).toBe(0.30);
  });

  test('a custom threshold is respected', () => {
    const cache = [{ id: 'a', coverEmbedding: [1, 0] }]; // similarity 1
    expect(rankFaceAlbumMatches([1, 0], cache, 0.99).bestMatch).not.toBeNull();
    expect(rankFaceAlbumMatches([1, 0], cache, 1.01).bestMatch).toBeNull();
  });

  test('on a tie, the first-encountered album wins (stable sort)', () => {
    const cache = [
      { id: 'first', coverEmbedding: [1, 0] },
      { id: 'second', coverEmbedding: [1, 0] },
    ];
    const { bestMatch } = rankFaceAlbumMatches([1, 0], cache);
    expect(bestMatch.id).toBe('first');
  });
});
