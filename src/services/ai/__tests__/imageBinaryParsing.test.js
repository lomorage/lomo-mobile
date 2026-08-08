const mockReadAsStringAsync = jest.fn();

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: (...args) => mockReadAsStringAsync(...args),
}));

import {
  readJpegExifOrientation,
  readImagePhysicalDimensions,
  base64ToFloat32Array,
} from '../imageBinaryParsing';

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

// Builds a minimal JPEG: SOI, then an APP1/EXIF segment carrying a single
// Orientation (0x0112) IFD entry, little-endian TIFF byte order.
function buildJpegWithExifOrientation(orientation) {
  const tiff = [
    0x49, 0x49, 0x2A, 0x00, // "II", magic 42 (LE)
    0x08, 0x00, 0x00, 0x00, // IFD offset = 8, right after this 8-byte header
    0x01, 0x00,             // numEntries = 1
    // IFD entry: tag=0x0112 (Orientation), type=SHORT(3), count=1, value=orientation
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00,
  ];
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const app1Body = [...exifHeader, ...tiff];
  const segLength = app1Body.length + 2; // includes the 2 length bytes themselves
  const app1 = [0xFF, 0xE1, (segLength >> 8) & 0xff, segLength & 0xff, ...app1Body];
  return [0xFF, 0xD8, ...app1];
}

function buildMinimalPng(width, height) {
  const bytes = new Array(24).fill(0);
  bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x4E; bytes[3] = 0x47; // PNG signature start
  bytes[16] = (width >> 24) & 0xff; bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff; bytes[19] = width & 0xff;
  bytes[20] = (height >> 24) & 0xff; bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff; bytes[23] = height & 0xff;
  return bytes;
}

function buildJpegWithDimensions(width, height) {
  // SOI, then a SOF0 marker segment: FF C0, length, precision, height(2B), width(2B)
  return [
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ];
}

beforeEach(() => {
  mockReadAsStringAsync.mockReset();
});

describe('base64ToFloat32Array', () => {
  test('round-trips known float32 values', () => {
    const original = new Float32Array([1.5, -2.25, 0, 3.75]);
    const base64 = Buffer.from(original.buffer).toString('base64');
    const decoded = base64ToFloat32Array(base64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});

describe('readJpegExifOrientation', () => {
  test('reads the Orientation tag out of an EXIF APP1 segment', async () => {
    const bytes = buildJpegWithExifOrientation(6);
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64(bytes));
    const orientation = await readJpegExifOrientation('file:///photo.jpg');
    expect(orientation).toBe(6);
  });

  test('defaults to 1 when there is no EXIF data (plain JPEG)', async () => {
    const bytes = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x00]; // SOI then straight to SOS
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64(bytes));
    const orientation = await readJpegExifOrientation('file:///photo.jpg');
    expect(orientation).toBe(1);
  });

  test('defaults to 1 for a non-JPEG file', async () => {
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64([0x00, 0x01, 0x02, 0x03]));
    const orientation = await readJpegExifOrientation('file:///not-a-photo.bin');
    expect(orientation).toBe(1);
  });

  test('falls back to a full-file read when the partial (length/position) read is unsupported', async () => {
    const bytes = buildJpegWithExifOrientation(3);
    mockReadAsStringAsync
      .mockRejectedValueOnce(new Error('partial reads not supported on this platform'))
      .mockResolvedValueOnce(bytesToBase64(bytes));
    const orientation = await readJpegExifOrientation('file:///photo.jpg');
    expect(orientation).toBe(3);
    expect(mockReadAsStringAsync).toHaveBeenCalledTimes(2);
  });

  test('defaults to 1 and does not throw when all reads fail', async () => {
    mockReadAsStringAsync.mockRejectedValue(new Error('file not found'));
    const orientation = await readJpegExifOrientation('file:///missing.jpg');
    expect(orientation).toBe(1);
  });
});

describe('readImagePhysicalDimensions', () => {
  test('parses PNG width/height from the IHDR header', async () => {
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64(buildMinimalPng(800, 600)));
    const dims = await readImagePhysicalDimensions('file:///photo.png');
    expect(dims).toEqual({ w: 800, h: 600 });
  });

  test('parses JPEG width/height from the SOF0 marker', async () => {
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64(buildJpegWithDimensions(1920, 1080)));
    const dims = await readImagePhysicalDimensions('file:///photo.jpg');
    expect(dims).toEqual({ w: 1920, h: 1080 });
  });

  test('returns null for unrecognized file formats', async () => {
    mockReadAsStringAsync.mockResolvedValueOnce(bytesToBase64([0x00, 0x01, 0x02, 0x03]));
    const dims = await readImagePhysicalDimensions('file:///not-a-photo.bin');
    expect(dims).toBeNull();
  });

  test('returns null (not a throw) when the file read fails', async () => {
    mockReadAsStringAsync.mockRejectedValue(new Error('file not found'));
    const dims = await readImagePhysicalDimensions('file:///missing.jpg');
    expect(dims).toBeNull();
  });
});
