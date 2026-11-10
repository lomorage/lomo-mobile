// The distinct file extensions in a set of refused rows, lowercased and dotted (".avif"), at most
// three so the line stays readable. Empty when none can be worked out.
//
// Taken from the server's wording first ("Not implemented: extension: avif"), because
// MediaAsset.filename is NULL for local assets -- insertLocalAssets never writes it -- so reading
// the filename alone would have named nothing on a real phone. The filename is kept as a fallback
// for the rows that do carry one.
export function kindsOf(rows) {
    const kinds = [];
    for (const row of rows || []) {
        const fromReason = /extension:\s*([A-Za-z0-9]+)/.exec(row?.reason || '');
        let ext = fromReason ? fromReason[1].toLowerCase() : '';
        if (!ext) {
            const name = row?.filename || '';
            const dot = name.lastIndexOf('.');
            ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
        }
        if (ext && !kinds.includes(`.${ext}`)) kinds.push(`.${ext}`);
    }
    return kinds.slice(0, 3);
}
