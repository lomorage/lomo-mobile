// Turns AssetDBService.getBackupSummaryRows() into the numbers Free Up Space and the
// "photos are safe" summary show. Live photos count as photos (their mediaType is 'photo').

const emptyGroup = () => ({ total: 0, backedUp: 0, bytes: 0, unknownSize: 0, excluded: 0 });

export function summarizeBackup(rows) {
  const photos = emptyGroup();
  const videos = emptyGroup();
  for (const row of rows || []) {
    const group = row.mediaType === 'video' ? videos : photos;
    group.total += row.total || 0;
    group.backedUp += row.backedUp || 0;
    group.bytes += row.backedUpBytes || 0;
    group.unknownSize += row.unknownSize || 0;
    group.excluded += row.excluded || 0;
  }
  const total = photos.total + videos.total;
  const backedUp = photos.backedUp + videos.backedUp;
  // not backed up because the user excluded their album (Settings > Selective Backup)
  const skipped = photos.excluded + videos.excluded;
  return {
    photos,
    videos,
    total,
    backedUp,
    skipped,
    notBackedUp: total - backedUp - skipped,
    backedUpBytes: photos.bytes + videos.bytes,
    // some backed-up items have no recorded size yet, so backedUpBytes is a lower bound
    sizeIsPartial: photos.unknownSize + videos.unknownSize > 0,
  };
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// "3 photos and 2 videos", "1 photo", "2 videos", "nothing"
export function describeCounts(photoCount, videoCount) {
  const parts = [];
  if (photoCount > 0) parts.push(plural(photoCount, 'photo'));
  if (videoCount > 0) parts.push(plural(videoCount, 'video'));
  return parts.length > 0 ? parts.join(' and ') : 'nothing';
}

export function countByMediaType(items) {
  let photos = 0;
  let videos = 0;
  for (const item of items) {
    if (item.mediaType === 'video') videos++;
    else photos++;
  }
  return { photos, videos };
}

// What the "photos are safe" screen shows after BackupSafetyService.checkAll over `items`
// (backed-up local assets with mediaType and sizeBytes).
export function summarizeVerification(items, { safe, unsafe, weakEvidence }) {
  const safeSet = new Set(safe);
  const safeItems = items.filter(item => safeSet.has(item.id));
  const { photos, videos } = countByMediaType(safeItems);
  return {
    safePhotos: photos,
    safeVideos: videos,
    safeCount: safeItems.length,
    safeBytes: safeItems.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    sizeIsPartial: safeItems.some(item => !item.sizeBytes),
    unconfirmedCount: unsafe.length,
    weakEvidence: !!weakEvidence,
  };
}

// "today at 12:22", "yesterday at 9:05", "Oct 3 at 18:40" (or a full date in another year).
export function describeWhen(time, now = Date.now()) {
  const date = new Date(time);
  const clock = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86400000);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `yesterday at ${clock}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${day} at ${clock}`;
}
