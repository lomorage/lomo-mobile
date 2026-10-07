import { countByMediaType, describeCounts, summarizeBackup, summarizeVerification } from '../backupSummary';

test('summarizes photos and videos, treating anything not video as a photo', () => {
  const summary = summarizeBackup([
    { mediaType: 'photo', total: 100, backedUp: 90, backedUpBytes: 9000, unknownSize: 0 },
    { mediaType: 'video', total: 10, backedUp: 4, backedUpBytes: 40000, unknownSize: 1 },
    { mediaType: null, total: 2, backedUp: 2, backedUpBytes: 20, unknownSize: 0 },
  ]);
  expect(summary.photos).toEqual({ total: 102, backedUp: 92, bytes: 9020, unknownSize: 0 });
  expect(summary.videos).toEqual({ total: 10, backedUp: 4, bytes: 40000, unknownSize: 1 });
  expect(summary.total).toBe(112);
  expect(summary.backedUp).toBe(96);
  expect(summary.notBackedUp).toBe(16);
  expect(summary.backedUpBytes).toBe(49020);
  expect(summary.sizeIsPartial).toBe(true);
});

test('empty library', () => {
  expect(summarizeBackup([])).toMatchObject({ total: 0, backedUp: 0, notBackedUp: 0, backedUpBytes: 0, sizeIsPartial: false });
});

test('describes counts in plain words', () => {
  expect(describeCounts(1, 0)).toBe('1 photo');
  expect(describeCounts(12438, 2)).toBe('12,438 photos and 2 videos');
  expect(describeCounts(0, 1)).toBe('1 video');
  expect(describeCounts(0, 0)).toBe('nothing');
});

test('counts items by media type', () => {
  expect(countByMediaType([{ mediaType: 'video' }, { mediaType: 'photo' }, {}])).toEqual({ photos: 2, videos: 1 });
});

test('summarizes a library verification: only confirmed items count as safe', () => {
  const items = [
    { id: 'p1', mediaType: 'photo', sizeBytes: 100 },
    { id: 'p2', mediaType: 'photo', sizeBytes: 0 },
    { id: 'v1', mediaType: 'video', sizeBytes: 1000 },
    { id: 'v2', mediaType: 'video', sizeBytes: 5000 },
  ];
  const result = summarizeVerification(items, {
    safe: ['p1', 'p2', 'v1'], unsafe: [{ id: 'v2', reason: 'file_missing' }], weakEvidence: false,
  });
  expect(result).toEqual({
    safePhotos: 2, safeVideos: 1, safeCount: 3, safeBytes: 1100, sizeIsPartial: true,
    unconfirmedCount: 1, weakEvidence: false,
  });
});
