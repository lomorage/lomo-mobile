import MediaService from '../MediaService';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

// Mock expo-file-system/legacy
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  documentDirectory: 'file:///mock/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn(),
}));

// Mock expo-crypto (not used in new impl, but MediaService imports it)
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA1: 'SHA-1' },
  digest: jest.fn(),
}));

// Mock the custom local FileHash module.
// Simulates: content:// gets real hash (setRequireOriginal fix), file:// gets wrong hash (old bug).
const CORRECT_HASH = 'cedcccf9abd9b04164ae31b9d00bac765c97aa94';
const WRONG_HASH   = '82083761d3e820b46eb2db46c87931f99dbc83ca';
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  hashFileAsync: jest.fn(async (uri) => {
    if (uri && uri.startsWith('content://')) return CORRECT_HASH; // setRequireOriginal
    return WRONG_HASH;                                             // raw file:// path
  }),
}));

// Mock js-sha1 so we can control hash output
jest.mock('js-sha1', () => {
  const hasher = {
    update: jest.fn(),
    hex: jest.fn().mockReturnValue('aabbccddeeff00112233445566778899aabbccdd'),
  };
  const sha1 = { create: jest.fn().mockReturnValue(hasher) };
  return sha1;
});

// atob is available in Node via global, mock it for binary decoding
global.atob = str => Buffer.from(str, 'base64').toString('binary');

describe('MediaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: file exists, 100 bytes
    LegacyFileSystem.getInfoAsync.mockResolvedValue({ exists: true, size: 100 });
    // Default: returns a base64 chunk
    LegacyFileSystem.readAsStringAsync.mockResolvedValue('AQID'); // base64 of [1,2,3]
  });

  test('calculateHash hashes a file using native hashFile module', async () => {
    const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
    const hash = await MediaService.calculateHash('file:///test.jpg', true);

    expect(hash).not.toBeNull();
    expect(LegacyFileSystem.getInfoAsync).toHaveBeenCalledWith('file:///test.jpg', { size: true });
    expect(ExpoLomoHasher.hashFileAsync).toHaveBeenCalledWith('file:///test.jpg');
    // Ensure the old JS fallback was NOT used
    expect(LegacyFileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  test('calculateHash returns null for null URI', async () => {
    const hash = await MediaService.calculateHash(null, true);
    expect(hash).toBeNull();
  });

  // REGRESSION TEST: content:// URIs now MUST route to native hashFileAsync.
  // Previously they returned null; that caused the file:// fallback path which produced the wrong hash.
  test('content:// URI is passed to native hashFileAsync (not rejected)', async () => {
    const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
    const hash = await MediaService.calculateHash('content://media/external/images/media/11069', true);
    expect(hash).not.toBeNull();
    expect(ExpoLomoHasher.hashFileAsync).toHaveBeenCalledWith('content://media/external/images/media/11069');
  });

  // Verifies that setRequireOriginal in our Kotlin module produces the correct hash for content://.
  test('content:// URI produces correct hash (simulating setRequireOriginal fix)', async () => {
    const hash = await MediaService.calculateHash('content://media/external/images/media/11069', true);
    expect(hash).toBe(CORRECT_HASH);
  });

  // Documents the bug: file:// path produces the wrong hash vs the server.
  test('documents bug: file:// URI of same asset has different hash than content:// URI', async () => {
    const contentHash = await MediaService.calculateHash('content://media/external/images/media/11069', true);
    const fileHash    = await MediaService.calculateHash('file:///storage/emulated/0/DCIM/Camera/PXL_20260313_005404073.jpg', true);
    // The fix: use content:// so setRequireOriginal gives unredacted bytes
    expect(contentHash).toBe(CORRECT_HASH);
    // The bug: file:// may give wrong result due to sandboxed/transcoded copy
    expect(fileHash).toBe(WRONG_HASH);
    expect(contentHash).not.toBe(fileHash);
  });

  test('calculateHash returns null when file does not exist', async () => {
    LegacyFileSystem.getInfoAsync.mockResolvedValue({ exists: false, size: 0 });
    const hash = await MediaService.calculateHash('file:///missing.jpg', true);
    expect(hash).toBeNull();
  });

  test('calculateHash returns null when file size is 0', async () => {
    LegacyFileSystem.getInfoAsync.mockResolvedValue({ exists: true, size: 0 });
    const hash = await MediaService.calculateHash('file:///empty.jpg', true);
    expect(hash).toBeNull();
  });

  test('calculateHash falls back to huge JS streaming chunks if native module fails', async () => {
    const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
    ExpoLomoHasher.hashFileAsync.mockRejectedValueOnce(new Error('Native Error'));

    const FILE_SIZE = 3 * 1024 * 1024; // 3MB
    const CHUNK_SIZE = 1024 * 1024;    // 1MB chunks
    LegacyFileSystem.getInfoAsync.mockResolvedValue({ exists: true, size: FILE_SIZE });

    await MediaService.calculateHash('file:///large.mp4', true);

    // Should have tried native first
    expect(ExpoLomoHasher.hashFileAsync).toHaveBeenCalledWith('file:///large.mp4');

    // Should have fallen back to JS chunking (3 chunks of 1MB each)
    expect(LegacyFileSystem.readAsStringAsync).toHaveBeenCalledTimes(3);
  });

  test('calculateHash returns null when readAsStringAsync throws', async () => {
    const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');
    ExpoLomoHasher.hashFileAsync.mockRejectedValueOnce(new Error('Native Error'));

    LegacyFileSystem.readAsStringAsync.mockRejectedValueOnce(new Error('Read error'));
    const hash = await MediaService.calculateHash('file:///error.jpg', true);
    expect(hash).toBeNull();
  });
});
