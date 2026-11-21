// The file to hand to the share sheet for a photo only on the server: a copy downloaded under the
// photo's own name (IMG_1234.HEIC) when known, since the receiving app shows and saves it under
// the file name. One folder per account and photo keeps the names apart (see shareCacheDir).
import * as FileSystem from 'expo-file-system/legacy';
import AuthService from './AuthService';
import { cachedShareFileName, downloadFileName, fileUriIn, shareCacheDir, shareTempRoot } from '../utils/fileName';
import { shortKey } from '../utils/shortKey';

// One-off copies (no known account) handed over longer ago than this are removed when a new one
// is made: by then the receiving app has long read them.
const TEMP_COPY_MAX_AGE_MS = 60 * 60 * 1000;
// Folders of downloads still running, from any screen: never removed from under them.
const tempDirsInUse = new Set();
// When each copy of this run was handed over: its age counts from then, not from when its
// (possibly long) download started. Copies from earlier runs fall back to their folder's stamp.
const tempDirsDone = new Map();

async function removeOldTempCopies() {
  const root = shareTempRoot(FileSystem.cacheDirectory);
  const names = await FileSystem.readDirectoryAsync(root).catch(() => []);
  const now = Date.now();
  for (const name of names) {
    const dir = `${root}${name}/`;
    if (tempDirsInUse.has(dir)) continue;
    const since = tempDirsDone.get(dir) ?? Number(String(name).split('-')[0]);
    if (Number.isFinite(since) && now - since < TEMP_COPY_MAX_AGE_MS) continue;
    await FileSystem.deleteAsync(`${root}${name}`, { idempotent: true }).catch(() => {});
    tempDirsDone.delete(dir);
  }
}

// Returns the file's URI, or null when the user signed out or into another account while it
// downloaded: the old account's file (and name) must not reach the share sheet then.
export async function prepareRemoteShareFile(asset) {
  const session = AuthService.getSession();
  const remoteUrl = `${AuthService.getServerUrl()}/asset/${asset.hash}?token=${AuthService.getToken()}`;
  const accountId = AuthService.getAccountId();
  // Without a known account each share gets a one-off copy; old, unused ones are removed.
  if (!accountId) await removeOldTempCopies();
  const dir = shareCacheDir(FileSystem.cacheDirectory, accountId ? shortKey(accountId) : null, asset.hash);
  // The copy's own folder under the temp root (dir is <root>/<stamp>/<hash>/).
  const tempDir = accountId ? null : dir.slice(0, dir.length - `${asset.hash}/`.length);
  if (tempDir) tempDirsInUse.add(tempDir);
  try {
    return await downloadForShare(asset, dir, remoteUrl, session);
  } finally {
    if (tempDir) {
      tempDirsInUse.delete(tempDir);
      tempDirsDone.set(tempDir, Date.now());
    }
  }
}

async function downloadForShare(asset, dir, remoteUrl, session) {
  const downloadPath = `${dir}.download`;

  let uri;
  const cached = (await FileSystem.readDirectoryAsync(dir).catch(() => []))
    .find(name => name !== '.download');
  if (cached) {
    // Saved before the app learned the photo's original name: same file, so rename it rather
    // than download it again.
    const wanted = cachedShareFileName(cached, asset);
    uri = fileUriIn(dir, cached);
    if (wanted !== cached) {
      const renamed = fileUriIn(dir, wanted);
      await FileSystem.moveAsync({ from: uri, to: renamed })
        .then(() => { uri = renamed; })
        .catch(() => {});
    }
  } else {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const result = await FileSystem.downloadAsync(remoteUrl, downloadPath);
    if (result.status >= 400) {
      await FileSystem.deleteAsync(downloadPath, { idempotent: true }).catch(() => {});
      throw new Error(`The server could not send this photo (HTTP ${result.status}).`);
    }
    uri = fileUriIn(dir, downloadFileName(asset, result.headers));
    await FileSystem.moveAsync({ from: downloadPath, to: uri });
  }

  if (AuthService.getSession() !== session) return null;
  return uri;
}
