// Builds the key used to look up an extracted Live Photo video in the
// in-memory cache. Remote assets key on their content hash; local/synced
// assets key on a sanitized version of their local media-library identifier
// (which often contains slashes or other characters unsafe as an object key).
export const getCacheKey = (item) => {
    if (item.status === 'remote') {
        return item.hash;
    }
    // For local and synced assets, sanitize item.id (which is the localIdentifier)
    return item.id ? item.id.replace(/[^a-zA-Z0-9]/g, '') : '';
};
