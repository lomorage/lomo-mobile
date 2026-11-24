import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'react-native';

const mimeTypes = new Map(Object.entries({
  'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif',
  'text/html': 'html', 'application/octet-stream': 'octet_stream',
}));

export function previewFormat(bytes) {
  if (bytes.startsWith('\xff\xd8\xff')) return 'jpeg';
  if (bytes.startsWith('\x89PNG\r\n\x1a\n')) return 'png';
  if (bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') return 'webp';
  if (bytes.slice(4, 8) === 'ftyp') {
    const brand = bytes.slice(8, 12);
    if (['avif', 'avis'].includes(brand)) return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'heic';
    if (['mif1', 'msf1'].includes(brand)) return 'heif';
  }
  if (/^\s*<(?:!doctype\s+html|html\b)/i.test(bytes)) return 'html';
  return 'unknown';
}

export async function previewDiagnostics(uri, url, headers) {
  const header = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'content-type');
  const mime = String(header?.[1] || '').split(';')[0].trim().toLowerCase();
  const fields = {
    contentType: mime ? (mimeTypes.get(mime) || 'other') : 'missing',
    requestedWebp: /[?&]icodec=webp(?:&|$)/.test(url),
  };
  try {
    const info = await FileSystem.getInfoAsync(uri);
    fields.fileExists = info.exists;
    if (!info.exists) return fields;
    fields.fileBytes = info.size;
  } catch (_e) { /* Still try reading the file. */ }
  try {
    const prefix = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64, position: 0, length: 64,
    });
    fields.fileFormat = previewFormat(atob(prefix));
  } catch (_e) { fields.fileFormat = 'unreadable'; }
  try {
    const { width, height } = await Image.getSize(uri);
    fields.systemDecode = 'ok';
    fields.width = width;
    fields.height = height;
  } catch (_e) { fields.systemDecode = 'failed'; }
  return fields;
}
