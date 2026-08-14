// expo-image (Android/Glide) surfaces load failures as a raw exception
// message string, not a structured status code. A 404 on a preview URL
// means the server genuinely doesn't have that asset (e.g. a stale/orphaned
// hash) -- retrying with backoff just leaves the tile looking "stuck
// loading" for several more seconds before failing the same way again.
// Anything else (timeout, connection reset, DNS hiccup) is presumably
// transient and still worth retrying.
export function isNotFoundImageError(errorMessage) {
    if (!errorMessage) return false;
    return /\b404\b/.test(errorMessage);
}
