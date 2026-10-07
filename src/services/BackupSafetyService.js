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
  LINKED_ONLY: 'linked_only',
  DAMAGED: 'damaged',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  SERVER_UNREACHABLE: 'server_unreachable',
};

// Server statuses (lomod common/check/store.go) the next backup should fix by re-uploading.
const REUPLOAD_STATUSES = new Set(['not_found', 'file_missing']);

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
    try {
      statusByHash = await this._verifyOnServer(candidates.map(c => c.hash));
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

    for (const { id, hash } of candidates) {
      const status = statusByHash.get(hash.toLowerCase());
      if (status === 'ok') continue;
      reasons.set(id, SERVER_STATUS_REASONS[status] || UNSAFE_REASONS.SERVER_UNREACHABLE);
      if (REUPLOAD_STATUSES.has(status)) {
        await AssetDBService.markAssetNotUploaded(id).catch(() => {});
      }
    }
    return { reasons, weakEvidence: false };
  }

  // Returns a Map of lowercased hash -> server status.
  async _verifyOnServer(hashes) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token) throw new Error('Not connected to a Lomorage server');

    const statusByHash = new Map();
    for (let i = 0; i < hashes.length; i += VERIFY_BATCH_SIZE) {
      const batch = hashes.slice(i, i + VERIFY_BATCH_SIZE);
      const response = await axios.post(`${serverUrl}/assets/verify`, { hashes: batch }, {
        headers: { Authorization: `token=${token}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      for (const item of response.data?.assets || []) {
        statusByHash.set(String(item.hash).toLowerCase(), item.status);
      }
    }
    return statusByHash;
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
