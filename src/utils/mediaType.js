const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm'];

// Determines whether a filename (or any string ending in a file extension,
// such as a remote Merkle tree tag) refers to a video, based on its extension.
export function isVideoExtension(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}
