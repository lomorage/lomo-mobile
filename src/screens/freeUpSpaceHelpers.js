import { UNSAFE_REASONS } from '../services/BackupSafetyService';
import { countByMediaType, describeCounts } from '../utils/backupSummary';

// A verification older than this is redone before deleting (the computer may have changed).
export const VERIFY_MAX_AGE_MS = 5 * 60 * 1000;

const REASON_TEXT = {
    [UNSAFE_REASONS.NOT_BACKED_UP]: 'not backed up yet',
    [UNSAFE_REASONS.MODIFIED_SINCE_BACKUP]: 'changed since they were backed up',
    [UNSAFE_REASONS.MISSING_LOCALLY]: 'no longer on this phone',
    [UNSAFE_REASONS.MISSING_ON_SERVER]: 'not found on your Lomorage computer — they will be backed up again',
    [UNSAFE_REASONS.FILE_MISSING]: 'missing from your Lomorage computer',
    [UNSAFE_REASONS.LINKED_ONLY]: 'only in a folder on your computer, not in your Lomorage library',
    [UNSAFE_REASONS.DAMAGED]: 'failed the last check on your Lomorage computer',
    [UNSAFE_REASONS.STORAGE_UNAVAILABLE]: "couldn't be checked — the drive with your photos isn't available on your Lomorage computer",
    [UNSAFE_REASONS.SERVER_UNREACHABLE]: "couldn't be checked — your Lomorage computer isn't reachable",
    [UNSAFE_REASONS.UNCONFIRMED]: "couldn't be confirmed by your Lomorage computer",
};

/**
 * Turns a BackupSafetyService result into the confirmation text and the ids that
 * may actually be deleted. Items that failed verification are kept on the phone.
 */
export function buildDeleteConfirmation({ safe, unsafe, weakEvidence }, items, formatSize) {
    const safeSet = new Set(safe);
    const safeBytes = items
        .filter(item => safeSet.has(item.id))
        .reduce((sum, item) => sum + (item.sizeBytes || 0), 0);

    const countsByReason = {};
    unsafe.forEach(({ reason }) => {
        countsByReason[reason] = (countsByReason[reason] || 0) + 1;
    });
    const keptLines = Object.entries(countsByReason)
        .map(([reason, count]) => `• ${count} ${REASON_TEXT[reason] || reason}`);

    const lines = [];
    if (safe.length > 0) {
        const one = safe.length === 1;
        const { photos, videos } = countByMediaType(items.filter(item => safeSet.has(item.id)));
        const where = weakEvidence ? 'backed up to' : 'confirmed safe on';
        lines.push(`${describeCounts(photos, videos)} ${one ? 'is' : 'are'} ${where} your Lomorage computer. Deleting ${one ? 'it' : 'them'} from this phone will free up ${formatSize(safeBytes)}.`);
        if (weakEvidence) {
            lines.push("Your Lomorage computer is running an older version, so we couldn't confirm the files themselves are intact. Updating it is recommended.");
        }
    }
    if (keptLines.length > 0) {
        lines.push(`${unsafe.length} will stay on this phone:\n${keptLines.join('\n')}`);
    }

    return { message: lines.join('\n\n'), deletable: safe };
}

export function isVerificationStale(verifiedAt, now = Date.now()) {
    return now - verifiedAt > VERIFY_MAX_AGE_MS;
}

// Android passes every id to the system delete request in one binder transaction (~1 MB
// limit), and each request is one confirmation dialog; iOS takes any number in one prompt.
export const ANDROID_DELETE_CHUNK = 1000;

/**
 * Deletes ids in chunks, calling onChunkDeleted(chunk) after each one that succeeded, so
 * a cancel or error part-way still records what really left the phone.
 * @returns {Promise<{ deleted: string[], error: Error | null }>}
 */
export async function deleteInChunks(ids, deleteChunk, onChunkDeleted, chunkSize) {
    const deleted = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        try {
            await deleteChunk(chunk);
        } catch (error) {
            return { deleted, error };
        }
        deleted.push(...chunk);
        await onChunkDeleted(chunk);
    }
    return { deleted, error: null };
}
