import axios from 'axios';
import AssetDBService from './AssetDBService';
import AuthService from './AuthService';
import MediaService from './MediaService';
import UploadService from './UploadService';

export const UNSAFE_REASONS = {
  NOT_BACKED_UP: 'not_backed_up',
  MODIFIED_SINCE_BACKUP: 'modified_since_backup',
  MISSING_LOCALLY: 'missing_locally',
  MISSING_ON_SERVER: 'missing_on_server',
  FILE_MISSING: 'file_missing',
  FILE_MISSING_RESTORING: 'file_missing_restoring', // being uploaded again to put the file back
  LINKED_ONLY: 'linked_only',
  DAMAGED: 'damaged',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  SERVER_UNREACHABLE: 'server_unreachable',
  UNCONFIRMED: 'unconfirmed', // the server answered, but not with anything we recognize
};

// Server statuses (lomod common/check/store.go) the next backup fixes by re-uploading. Not
// file_missing: the server still lists the hash, so the backup sees nothing to upload (and
// sync marks it uploaded again). Servers that say `repair: true` take it back by a direct
// upload instead (see _restoreMissing); older ones refuse it (409) and it stays on the phone.
const REUPLOAD_STATUSES = new Set(['not_found']);

const SERVER_STATUS_REASONS = {
  not_found: UNSAFE_REASONS.MISSING_ON_SERVER,
  file_missing: UNSAFE_REASONS.FILE_MISSING,
  linked: UNSAFE_REASONS.LINKED_ONLY,
  bad: UNSAFE_REASONS.DAMAGED,
  unavailable: UNSAFE_REASONS.STORAGE_UNAVAILABLE,
};

const VERIFY_BATCH_SIZE = 500; // lomod's per-request limit
const HEAD_CHECK_CONCURRENCY = 4;
const LOCAL_CHECK_CONCURRENCY = 8; // MediaLibrary lookups for large selections

/**
 * Last line of defence before deleting local originals.
 *
 * On the phone: the asset must be uploaded and unchanged since it was hashed (an edited
 * photo keeps its id, so the backup would be of the old version).
 * On the server (POST /assets/verify): the asset must be in the library — not only indexed
 * from a user folder — with its file on disk, and not flagged by the latest consistency
 * check. Servers without that endpoint fall back to HEAD /asset/{sha1}, which only proves
 * a DB record exists; the result is then marked weakEvidence.
 *
 * @param {string[]} ids local asset ids
 * @returns {Promise<{ safe: string[], unsafe: { id: string, reason: string }[], weakEvidence: boolean }>}
 */
class BackupSafetyService {
  constructor() {
    this.restoring = Promise.resolve(); // settles when every queued restore is done
    this.restorePending = new Set(); // ids queued or being restored, so a re-check doesn't queue them twice
    this.restoredListeners = new Set();
    this.restoredSinceNotify = 0; // files put back since onRestored listeners were last called
  }

  /**
   * Calls listener once every queued restore is done, if at least one put a file back; returns
   * an unsubscribe function.
   */
  onRestored(listener) {
    this.restoredListeners.add(listener);
    return () => this.restoredListeners.delete(listener);
  }

  // A restore is an upload like any backup, so it follows the same settings (backup on, not
  // paused, Wi-Fi / charging / night only). Required lazily: AutoBackupManager pulls in the
  // notification and background-task modules, and itself depends on much of the app.
  _uploadsAllowed() {
    return require('./AutoBackupManager').default.canUploadNow();
  }

  async checkBeforeDelete(ids) {
    const rows = await AssetDBService.getBackupRowsByIds(ids);
    const rowById = new Map(rows.map(row => [row.id, row]));

    const localReasons = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        localReasons[i] = await this._checkLocal(ids[i], rowById.get(ids[i]));
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOCAL_CHECK_CONCURRENCY, ids.length) }, worker));

    const unsafe = [];
    const candidates = [];
    ids.forEach((id, i) => {
      if (localReasons[i]) unsafe.push({ id, reason: localReasons[i] });
      else candidates.push({ id, hash: rowById.get(id).hash });
    });

    const { reasons, weakEvidence } = await this._checkServer(candidates);
    const safe = [];
    for (const { id } of candidates) {
      const reason = reasons.get(id);
      if (reason) unsafe.push({ id, reason });
      else safe.push(id);
    }

    if (unsafe.length > 0) {
      console.warn(`[BackupSafetyService] ${unsafe.length}/${ids.length} assets not safe to delete:`, unsafe);
    }
    // keep the caller's order
    const order = new Map(ids.map((id, i) => [id, i]));
    unsafe.sort((a, b) => order.get(a.id) - order.get(b.id));
    return { safe, unsafe, weakEvidence };
  }

  /**
   * checkBeforeDelete for a whole library, VERIFY_BATCH_SIZE at a time, reporting
   * onProgress(checked, total) after each batch.
   */
  async checkAll(ids, onProgress) {
    const result = { safe: [], unsafe: [], weakEvidence: false };
    for (let i = 0; i < ids.length; i += VERIFY_BATCH_SIZE) {
      const part = await this.checkBeforeDelete(ids.slice(i, i + VERIFY_BATCH_SIZE));
      result.safe.push(...part.safe);
      result.unsafe.push(...part.unsafe);
      result.weakEvidence = result.weakEvidence || part.weakEvidence;
      if (onProgress) onProgress(Math.min(i + VERIFY_BATCH_SIZE, ids.length), ids.length);
    }
    return result;
  }

  // Returns null when the phone side is fine, otherwise one of UNSAFE_REASONS.
  async _checkLocal(id, row) {
    if (!row || !row.hash || row.uploaded !== 1) return UNSAFE_REASONS.NOT_BACKED_UP;

    const info = await MediaService.getAssetInfo(id);
    if (!info) return UNSAFE_REASONS.MISSING_LOCALLY;
    if (row.hashModificationTime == null
        || Math.floor(info.modificationTime) !== Math.floor(row.hashModificationTime)) {
      return UNSAFE_REASONS.MODIFIED_SINCE_BACKUP;
    }
    return null;
  }

  // Returns a Map of id -> unsafe reason for the candidates the server can't vouch for.
  async _checkServer(candidates) {
    const reasons = new Map();
    if (candidates.length === 0) return { reasons, weakEvidence: false };

    let statusByHash;
    let canRepair;
    try {
      ({ statusByHash, canRepair } = await this._verifyOnServer(candidates.map(c => c.hash)));
    } catch (e) {
      // Older lomod has no such route: gorilla/mux answers 405 (another /assets/... route
      // matches the path) or 404.
      if (e.response?.status === 404 || e.response?.status === 405) {
        console.warn('[BackupSafetyService] Server has no /assets/verify, falling back to HEAD checks.');
        return { reasons: await this._checkServerWithHead(candidates), weakEvidence: true };
      }
      console.warn('[BackupSafetyService] Verify request failed:', e.message);
      candidates.forEach(({ id }) => reasons.set(id, UNSAFE_REASONS.SERVER_UNREACHABLE));
      return { reasons, weakEvidence: false };
    }

    // Only say "being backed up again" when the backup settings let it happen now; otherwise
    // it's plain file_missing, and the next check (on allowed conditions) restores it.
    const anyMissing = canRepair && candidates.some(c => statusByHash.get(c.hash.toLowerCase()) === 'file_missing');
    const restoreNow = anyMissing && await this._uploadsAllowed();
    const toRestore = [];
    for (const { id, hash } of candidates) {
      const status = statusByHash.get(hash.toLowerCase());
      if (status === 'ok') continue;
      if (status === 'file_missing' && restoreNow) {
        reasons.set(id, UNSAFE_REASONS.FILE_MISSING_RESTORING);
        toRestore.push({ id, hash });
        continue;
      }
      reasons.set(id, SERVER_STATUS_REASONS[status] || UNSAFE_REASONS.UNCONFIRMED);
      if (REUPLOAD_STATUSES.has(status)) {
        await AssetDBService.markAssetNotUploaded(id).catch(() => {});
      }
    }
    if (toRestore.length > 0) this._restoreMissing(toRestore);
    return { reasons, weakEvidence: false };
  }

  /**
   * Uploads these assets ({ id, hash }) again so the server puts their missing files back. In
   * the background: the check reports them as unsafe right away, and they become safe to delete
   * once restored. Restores run one at a time; `restoring` settles when all queued are done.
   * Ids already queued are skipped, and the backup settings are checked again before each
   * upload, since they can change while earlier restores run.
   */
  _restoreMissing(items) {
    const fresh = items.filter(({ id }) => !this.restorePending.has(id));
    if (fresh.length === 0) return this.restoring;
    fresh.forEach(({ id }) => this.restorePending.add(id));

    const run = async () => {
      try {
        for (let i = 0; i < fresh.length; i++) {
          const { id, hash } = fresh[i];
          if (!(await this._uploadsAllowed())) {
            console.log(`[BackupSafetyService] Backup settings don't allow uploading now; ${fresh.length - i} restore(s) wait for the next check.`);
            break;
          }
          const info = await MediaService.getAssetInfo(id);
          if (!info) continue;
          try {
            // the hash the server reported missing: uploadAsset needn't hash the file again
            const result = await UploadService.uploadAsset({ ...info, hash });
            // Only an upload of this very hash puts the file back. A "duplicate" (the server
            // already had it) or a different hash (e.g. a Live Photo re-encoded since) fixed
            // nothing; counting it would re-check, re-queue and "succeed" again, in a loop.
            if (result?.success && !result.duplicate && result.hash?.toLowerCase() === hash.toLowerCase()) {
              this.restoredSinceNotify++;
              console.log(`[BackupSafetyService] Restored missing file of ${id} on the server.`);
            } else {
              console.warn(`[BackupSafetyService] Re-upload of ${id} did not restore ${hash}:`, JSON.stringify(result));
            }
          } catch (e) {
            console.warn(`[BackupSafetyService] Could not restore ${id}:`, e.message);
          }
        }
      } finally {
        fresh.forEach(({ id }) => this.restorePending.delete(id));
      }
      // Once the whole queue has drained, not per batch: restoring a lost library queues it 500 at
      // a time, and each notification makes Backup Status verify the entire library again. Only
      // after a success: a re-check then finds it ok, so this can't loop on a failing restore.
      if (this.restorePending.size === 0 && this.restoredSinceNotify > 0) {
        this.restoredSinceNotify = 0;
        this.restoredListeners.forEach((listener) => {
          try { listener(); } catch (e) { console.warn('[BackupSafetyService] onRestored listener failed:', e.message); }
        });
      }
    };
    this.restoring = this.restoring.then(run);
    return this.restoring;
  }

  // Returns a Map of lowercased hash -> server status, and whether the server takes a
  // re-upload of a file_missing asset to restore it.
  async _verifyOnServer(hashes) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token) throw new Error('Not connected to a Lomorage server');

    const statusByHash = new Map();
    let canRepair = false;
    for (let i = 0; i < hashes.length; i += VERIFY_BATCH_SIZE) {
      const batch = hashes.slice(i, i + VERIFY_BATCH_SIZE);
      const response = await axios.post(`${serverUrl}/assets/verify`, { hashes: batch }, {
        headers: { Authorization: `token=${token}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      // a server-wide capability; require it of every batch's reply rather than trusting the last
      canRepair = response.data?.repair === true && (i === 0 || canRepair);
      for (const item of response.data?.assets || []) {
        statusByHash.set(String(item.hash).toLowerCase(), item.status);
      }
    }
    return { statusByHash, canRepair };
  }

  async _checkServerWithHead(candidates) {
    const reasons = new Map();
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const { id, hash } = candidates[next++];
        try {
          const status = await UploadService.checkUploadStatus(hash);
          if (!status.exists) {
            reasons.set(id, UNSAFE_REASONS.MISSING_ON_SERVER);
            await AssetDBService.markAssetNotUploaded(id).catch(() => {});
          }
        } catch {
          reasons.set(id, UNSAFE_REASONS.SERVER_UNREACHABLE);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HEAD_CHECK_CONCURRENCY, candidates.length) }, worker));
    return reasons;
  }
}

export default new BackupSafetyService();
