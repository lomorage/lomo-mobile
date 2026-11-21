import MediaService from '../services/MediaService';

// Deletes photos from the server and returns the hashes (lowercase) it kept: refused, or all of
// them when the request failed. Those photos are still in the backup, so their rows must stay.
export async function deleteRemoteKeepingFailures(remoteItems) {
  if (remoteItems.length === 0) return new Set();
  try {
    const { failed } = await MediaService.deleteRemoteAssets(remoteItems);
    return new Set(failed.map(id => String(id).toLowerCase()));
  } catch (error) {
    console.warn('[remoteCleanup] Remote deletion failed:', error.message);
    return new Set(remoteItems.map(item => String(item.idOrHash).toLowerCase()));
  }
}

export const keptMessage = (count) =>
  `${count} ${count === 1 ? 'photo' : 'photos'} could not be deleted from the Lomorage backup and ${count === 1 ? 'was' : 'were'} kept. Try again later.`;
