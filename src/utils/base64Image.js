// Base64 signatures for the image formats the server actually produces for
// album covers (face crops, thumbnails). PNG's magic bytes (\x89PNG\r\n\x1a\n)
// always base64-encode to the "iVBORw0KGgo" prefix; anything else defaults to
// JPEG, which is what most covers actually are.
const PNG_BASE64_PREFIX = 'iVBORw0KGgo';

// Builds a displayable data: URI from a raw (unprefixed) base64 image string,
// sniffing PNG vs JPEG from the base64 itself rather than assuming JPEG --
// mislabeling a PNG as image/jpeg makes some native decoders fail to render
// it at all (blank image) even though the underlying bytes are valid.
export function buildImageDataUri(base64) {
  if (!base64) return null;
  if (base64.startsWith('data:')) return base64;
  const mimeType = base64.startsWith(PNG_BASE64_PREFIX) ? 'image/png' : 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}
