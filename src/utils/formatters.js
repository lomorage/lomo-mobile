// Formats a byte count as a short human-readable string (e.g. "512 B", "2.3 KB", "4.1 MB").
// Caps out at MB (no GB tier) — matches the current call sites, which only ever
// display single-asset/single-batch sizes.
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

// Formats a byte count using log-scaled B/KB/MB/GB tiers (unlike formatBytes
// above, this one does go up to GB). This was duplicated near-verbatim across
// DuplicatesScreen (x3), FreeUpSpaceScreen, and SettingsScreen, each with a
// slightly different fallback string and decimal precision for the empty/zero
// case — `options` lets each call site keep its exact existing behavior.
export function formatBytesLog(bytes, { fallback = '0 B', decimals = 2 } = {}) {
  if (!bytes) return fallback;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}
