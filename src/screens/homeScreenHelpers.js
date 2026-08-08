// Parses the fixed set of quick-filter time chip values (e.g. "yesterday",
// "last week", or a bare 4-digit year) into a {startTime, endTime} range, or
// null if the value isn't one of the recognized chip tokens. For parsing a
// date embedded in free-text search queries, see services/ai/searchQueryParser.
export const parseTimeTokenExtra = (value) => {
    const val = value.trim().toLowerCase();
    const now = new Date();

    const startOfDay = (d) => {
        const nd = new Date(d);
        nd.setHours(0, 0, 0, 0);
        return nd.getTime();
    };
    const endOfDay = (d) => {
        const nd = new Date(d);
        nd.setHours(23, 59, 59, 999);
        return nd.getTime();
    };

    if (/^\d{4}$/.test(val)) {
        const year = parseInt(val, 10);
        const startTime = new Date(year, 0, 1, 0, 0, 0, 0).getTime();
        const endTime = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
        return { startTime, endTime };
    }

    if (val === 'yesterday') {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        return { startTime: startOfDay(yesterday), endTime: endOfDay(yesterday) };
    }

    if (val === 'last week') {
        const lastWeekStart = new Date(now);
        lastWeekStart.setDate(now.getDate() - 7 - now.getDay());
        const lastWeekEnd = new Date(lastWeekStart);
        lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
        return { startTime: startOfDay(lastWeekStart), endTime: endOfDay(lastWeekEnd) };
    }

    if (val === 'last month') {
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        return { startTime: startOfDay(lastMonthStart), endTime: endOfDay(lastMonthEnd) };
    }

    if (val === 'last year') {
        const startTime = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0).getTime();
        const endTime = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999).getTime();
        return { startTime, endTime };
    }

    if (val === 'this year') {
        const startTime = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).getTime();
        return { startTime, endTime: endOfDay(now) };
    }

    return null;
};

// Determines whether an asset is a Live Photo: checks local metadata first,
// then falls back to the cached remote Merkle tree tag (for synced assets
// whose local media-library metadata isn't available). Pass in
// SyncService.remoteTree for `remoteTree`.
export const isLivePhoto = (asset, remoteTree) => {
    // 1. Local or synced asset with mediaSubtypes metadata
    if (asset.mediaSubtypes && (asset.mediaSubtypes.includes('livePhoto') || asset.mediaSubtypes.includes('live'))) {
        return true;
    }
    // 2. Synced local or remote asset check using filename
    if (asset.filename && asset.filename.toLowerCase().endsWith('.zip')) {
        return true;
    }
    // 3. Synced local or remote asset check using cached hash in remoteTree
    if (asset.hash) {
        const remoteNode = remoteTree?.getNodeByHash(asset.hash);
        if (remoteNode && remoteNode.tag && remoteNode.tag.toLowerCase().endsWith('.zip')) {
            return true;
        }
    }
    return false;
};
