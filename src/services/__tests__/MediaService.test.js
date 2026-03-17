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

// Mock the custom local FileHash module
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  hashFileAsync: jest.fn().mockResolvedValue('aabbccddeeff00112233445566778899aabbccdd'),
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

    expect(hash).toBe('aabbccddeeff00112233445566778899aabbccdd');
    expect(LegacyFileSystem.getInfoAsync).toHaveBeenCalledWith('file:///test.jpg', { size: true });
    expect(ExpoLomoHasher.hashFileAsync).toHaveBeenCalledWith('file:///test.jpg');
    // Ensure the old JS fallback was NOT used
    expect(LegacyFileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  test('calculateHash returns null for null URI', async () => {
    const hash = await MediaService.calculateHash(null, true);
    expect(hash).toBeNull();
  });

  test('calculateHash returns null for content:// URI', async () => {
    const hash = await MediaService.calculateHash('content://media/1234', true);
    expect(hash).toBeNull();
    expect(LegacyFileSystem.readAsStringAsync).not.toHaveBeenCalled();
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
