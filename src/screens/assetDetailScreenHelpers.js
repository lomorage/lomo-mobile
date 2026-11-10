import { parseBackendDate } from '../utils/backendDate';
import { isVideoExtension } from '../utils/mediaType';

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

// Epoch value in seconds or milliseconds -> ms (nothing before ~1973 is in ms).
const toMs = (value) => (value > 0 ? (value < 1e11 ? value * 1000 : value) : 0);

// The date line under a photo. Some items have no taken date (creationTime 0: e.g. videos, which
// have no EXIF to fall back on); showing 12/31/1969 for those is wrong, so use the file's
// modification time and otherwise show nothing.
export const formatTakenDate = (item) => {
    const ms = toMs(item && item.creationTime) || toMs(item && item.modificationTime);
    return ms > 0 ? new Date(ms).toLocaleString() : '';
};

// Width / height of the picture as drawn, for limiting zoom panning. Photos: the size the image
// view reported once loaded (after EXIF rotation), else the library's. Videos: unknown (the player
// letterboxes by itself and a rotated video's reported size can be swapped), so no limit beyond
// the view.
export const contentAspectOf = (item, loadedDims) => {
    if (!item || item.mediaType === 'video') return undefined;
    const w = loadedDims?.w || item.width;
    const h = loadedDims?.h || item.height;
    return w > 0 && h > 0 ? w / h : undefined;
};

// Fills an album item that lacks details from GET /asset/metadata/<hash>. lomod answers with the
// Go struct types.Asset, so the keys are capitalised (Name, Date) and there is no type field: a
// video is recognised by its file name, as everywhere else in the app. Values the item already
// has win (the phone's taken date; local rows know a video is a video).
export const mergeServerMetadata = (item, metadata) => {
    const name = item.filename || metadata?.Name || '';
    const serverDate = parseBackendDate(metadata?.Date);
    return {
        ...item,
        isMetadataPartial: false,
        filename: name,
        creationTime: item.creationTime > 0 ? item.creationTime : (serverDate ? serverDate.getTime() : item.creationTime),
        mediaType: isVideoExtension(name) ? 'video' : (item.mediaType || 'image'),
    };
};
