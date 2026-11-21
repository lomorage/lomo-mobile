// The file to hand to the share sheet for a photo only on the server: a copy downloaded under the
// photo's own name (IMG_1234.HEIC) when known, since the receiving app shows and saves it under
// the file name. One folder per account and photo keeps the names apart (see shareCacheDir).
import * as FileSystem from 'expo-file-system/legacy';
import AuthService from './AuthService';
import { cachedShareFileName, downloadFileName, fileUriIn, shareCacheDir, shareTempRoot } from '../utils/fileName';
import { shortKey } from '../utils/shortKey';

// Returns the file's URI, or null when the user signed out or into another account while it
// downloaded: the old account's file (and name) must not reach the share sheet then.
export async function prepareRemoteShareFile(asset) {
  const session = AuthService.getSession();
  const remoteUrl = `${AuthService.getServerUrl()}/asset/${asset.hash}?token=${AuthService.getToken()}`;
  const accountId = AuthService.getAccountId();
  if (!accountId) {
    // Without a known account each share gets a one-off copy; earlier ones are done with.
    await FileSystem.deleteAsync(shareTempRoot(FileSystem.cacheDirectory), { idempotent: true }).catch(() => {});
  }
  const dir = shareCacheDir(FileSystem.cacheDirectory, accountId ? shortKey(accountId) : null, asset.hash);
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
