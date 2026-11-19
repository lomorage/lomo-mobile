// File names shown for a photo and given to a downloaded copy.
//
// For a photo only on the server, `filename` is lomod's own date+id name (and must stay that:
// the media type and Live Photo detection read it), while `originalName` is the name it had on
// the phone that backed it up (IMG_1234.HEIC), when the server knows it.

export function displayFileName(asset) {
  if (!asset) return '';
  return asset.originalName || asset.filename || '';
}

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/zip': 'zip',
};

function header(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

// The file name in a Content-Disposition header: filename* (RFC 5987) first, then filename.
export function nameFromContentDisposition(value) {
  if (!value) return '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch (_malformed) {
      // malformed escape: fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(value) || /filename\s*=\s*([^;]+)/i.exec(value);
  return plain ? plain[1].trim() : '';
}

// Characters file systems or share targets refuse, and any directory part.
export function safeFileName(name) {
  const base = String(name || '').split(/[/\\]/).pop();
  return base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').trim().replace(/^\.+$/, '');
}

function splitExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
}

// The name for a downloaded copy of `asset` (e.g. to share). `headers` are the download's
// response headers: lomod names the file there (original name, with the extension of what it
// actually sent, which may be a converted copy), and Content-Type tells the format otherwise.
export function downloadFileName(asset, headers) {
  const fromServer = safeFileName(nameFromContentDisposition(header(headers, 'content-disposition')));
  if (fromServer) return fromServer;

  const original = safeFileName(asset?.originalName || '');
  const [stem, originalExt] = splitExt(original);
  const type = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type] || originalExt.toLowerCase()
    || (asset?.mediaType === 'video' ? 'mp4' : 'jpg');
  const base = stem || `photo_${String(asset?.hash || '').slice(0, 8) || 'lomorage'}`;
  return `${base}.${ext}`;
}
