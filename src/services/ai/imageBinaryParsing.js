import * as FileSystem from 'expo-file-system/legacy';

// Pure JS JPEG EXIF orientation reader.
// Attempts a partial read of the first 64KB of the file to locate the EXIF APP1 marker.
// Returns the EXIF Orientation integer (1-8), or 1 (no rotation) on failure.
export async function readJpegExifOrientation(filePath) {
  try {
    const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    let b64;
    try {
      // Try partial read first (supported by expo-file-system legacy on both platforms)
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 65536,
        position: 0,
      });
    } catch (_) {
      // Fallback: read the full file (may be slow for large photos)
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Only process the first 87382 characters (~65KB of binary)
      if (b64.length > 87382) b64 = b64.substring(0, 87382);
    }

    const binary = atob(b64);
    const len = Math.min(binary.length, 65536);
    const view = new Uint8Array(len);
    for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);

    // Check JPEG SOI marker (0xFFD8)
    if (view[0] !== 0xFF || view[1] !== 0xD8) return 1;

    let offset = 2;
    while (offset < len - 4) {
      if (view[offset] !== 0xFF) break;
      const marker = view[offset + 1];
      const segLength = (view[offset + 2] << 8) | view[offset + 3];
      // APP1 marker (0xFFE1) contains EXIF data
      if (marker === 0xE1) {
        // Check for "Exif\0\0" header at offset+4
        if (offset + 10 < len &&
            view[offset + 4] === 0x45 && // E
            view[offset + 5] === 0x78 && // x
            view[offset + 6] === 0x69 && // i
            view[offset + 7] === 0x66 && // f
            view[offset + 8] === 0x00 && // null
            view[offset + 9] === 0x00) { // null
          // TIFF header starts at offset + 10
          const tiffStart = offset + 10;
          if (tiffStart + 8 > len) return 1;
          // Byte order: 0x4949 = little-endian, 0x4D4D = big-endian
          const isLE = view[tiffStart] === 0x49 && view[tiffStart + 1] === 0x49;
          const readU16 = (pos) => isLE
            ? (view[pos] | (view[pos + 1] << 8))
            : ((view[pos] << 8) | view[pos + 1]);
          const readU32 = (pos) => isLE
            ? ((view[pos] | (view[pos + 1] << 8) | (view[pos + 2] << 16) | (view[pos + 3] << 24)) >>> 0)
            : (((view[pos] << 24) | (view[pos + 1] << 16) | (view[pos + 2] << 8) | view[pos + 3]) >>> 0);
          const ifdOffset = tiffStart + readU32(tiffStart + 4);
          if (ifdOffset + 2 > len) return 1;
          const numEntries = readU16(ifdOffset);
          for (let e = 0; e < numEntries; e++) {
            const entryOffset = ifdOffset + 2 + e * 12;
            if (entryOffset + 12 > len) break;
            const tag = readU16(entryOffset);
            if (tag === 0x0112) { // Orientation tag
              const orientation = readU16(entryOffset + 8);
              console.log(`[imageBinaryParsing] EXIF Orientation from file: ${orientation}`);
              return orientation;
            }
          }
        }
        break; // Only one APP1 segment
      }
      if (marker === 0xDA) break; // SOS = image data starts, stop parsing
      offset += 2 + segLength;
    }
  } catch (e) {
    console.warn('[imageBinaryParsing] readJpegExifOrientation failed:', e.message);
  }
  return 1; // Default: no rotation
}

// Helper: Parse PNG and JPEG file headers directly to extract physical dimensions.
// Reads the first 64KB as base64, decodes to binary, and parses structure in JS.
export async function readImagePhysicalDimensions(filePath) {
  try {
    const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    let b64;
    try {
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        length: 65536,
        position: 0,
      });
    } catch (_) {
      b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (b64.length > 87382) b64 = b64.substring(0, 87382);
    }

    const binary = atob(b64);
    const len = Math.min(binary.length, 65536);
    const view = new Uint8Array(len);
    for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);

    // 1. Check PNG signature: 89 50 4E 47
    if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) {
      if (len >= 24) {
        // Width is at offset 16 (4 bytes, big-endian)
        const w = (view[16] << 24) | (view[17] << 16) | (view[18] << 8) | view[19];
        // Height is at offset 20 (4 bytes, big-endian)
        const h = (view[20] << 24) | (view[21] << 16) | (view[22] << 8) | view[23];
        console.log(`[imageBinaryParsing] Parsed PNG physical dimensions: ${w}x${h}`);
        return { w, h };
      }
    }

    // 2. Check JPEG SOI marker: FF D8
    if (view[0] === 0xFF && view[1] === 0xD8) {
      let offset = 2;
      while (offset < len - 8) {
        if (view[offset] !== 0xFF) break;
        const marker = view[offset + 1];
        const segLength = (view[offset + 2] << 8) | view[offset + 3];

        // SOF markers: 0xC0 - 0xCF (excluding 0xC4, 0xC8, 0xCC)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const h = (view[offset + 5] << 8) | view[offset + 6];
          const w = (view[offset + 7] << 8) | view[offset + 8];
          console.log(`[imageBinaryParsing] Parsed JPEG physical dimensions: ${w}x${h}`);
          return { w, h };
        }

        if (marker === 0xDA) break; // SOS = start of scan, stop parsing
        offset += 2 + segLength;
      }
    }
  } catch (e) {
    console.warn('[imageBinaryParsing] readImagePhysicalDimensions failed:', e.message);
  }
  return null;
}

// Base64 helper to convert base64 string to Float32Array
export function base64ToFloat32Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}
