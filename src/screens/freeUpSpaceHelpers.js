import { UNSAFE_REASONS } from '../services/BackupSafetyService';

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
        const where = weakEvidence ? 'backed up to' : 'confirmed safe on';
        lines.push(`${safe.length} ${one ? 'video is' : 'videos are'} ${where} your Lomorage computer. Deleting ${one ? 'it' : 'them'} from this phone will free up ${formatSize(safeBytes)}.`);
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
