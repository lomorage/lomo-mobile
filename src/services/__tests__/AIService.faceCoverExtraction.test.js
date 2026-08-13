jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock-cache/',
  documentDirectory: 'file:///mock-doc/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn().mockResolvedValue(),
  deleteAsync: jest.fn().mockResolvedValue(),
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn().mockResolvedValue({ isConnected: true }),
}));
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1),
  getBatteryStateAsync: jest.fn().mockResolvedValue(2),
  BatteryState: { CHARGING: 2 },
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));
jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
jest.mock('expo-media-library', () => ({}));
jest.mock('expo-location', () => ({}));
jest.mock('./../AssetDBService', () => ({
  db: null,
  saveAssetOCR: jest.fn(),
  saveAssetMetadata: jest.fn(),
}));
jest.mock('./../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));
jest.mock('./../MediaService', () => ({
  getPreviewUrl: jest.fn(),
  getAssetInfo: jest.fn(),
}));
jest.mock('./../TaskSchedulerService', () => ({
  waitUntilIdle: jest.fn().mockResolvedValue(),
}));
jest.mock('@infinitered/react-native-mlkit-text-recognition', () => ({
  recognizeText: jest.fn(),
}));
jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
  RNMLKitFaceDetector: jest.fn().mockImplementation(() => ({
    detectFaces: jest.fn().mockResolvedValue({ faces: [] }),
  })),
}));
jest.mock('../../../modules/expo-lomo-hasher', () => ({
  encodeFaceEmbeddingAsync: jest.fn(),
  encodeImageEmbeddingAsync: jest.fn(),
  encodeTextEmbeddingAsync: jest.fn(),
  sliceFileAsync: jest.fn(),
}));
jest.mock('../../../modules/expo-background-keepalive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn() },
  Image: { getSize: jest.fn((uri, onSuccess) => onSuccess(200, 200)) },
  PixelRatio: { get: jest.fn(() => 2) },
}));

const ExpoLomoHasher = require('../../../modules/expo-lomo-hasher');

import AIService from '../AIService';

function b64OfVector(values) {
  return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

// A face frame large enough to clear MIN_FACE_SIZE (80px) with no imageWidth
// passed to isFaceTooSmall, so only the absolute floor applies.
function bigFace() {
  return { frame: { origin: { x: 0, y: 0 }, size: { x: 150, y: 150 } } };
}

describe('AIService.extractBestMatchingFaceCrop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns an error without doing any work when there is no reference cover', async () => {
    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', null);
    expect(result).toEqual({ error: 'no_reference_cover' });
    expect(ExpoLomoHasher.encodeFaceEmbeddingAsync).not.toHaveBeenCalled();
  });

  test('returns an error when the reference cover itself fails to embed', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding: null });
    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'reference_embedding_failed' });
  });

  test('returns an error when no faces are found in the candidate photo', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding: b64OfVector([1, 0, 0]) });
    AIService.faceDetector.detectFaces.mockResolvedValueOnce({ faces: [] });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'no_faces_found' });
  });

  test('returns the crop when a single detected face closely matches the reference', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]) }) // reference cover embedding
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'matched-crop-b64' }); // candidate face
    AIService.faceDetector.detectFaces
      .mockResolvedValueOnce({ faces: [] }) // landmark-detection call inside the reference-cover embedding step
      .mockResolvedValueOnce({ faces: [bigFace()] }); // the actual candidate photo

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result.croppedImageBase64).toBe('matched-crop-b64');
    expect(result.similarity).toBeCloseTo(1, 5);
  });

  test('returns low_confidence when the best candidate face does not resemble the reference', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]) }) // reference
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'unrelated-crop-b64' }); // orthogonal, unrelated face
    AIService.faceDetector.detectFaces
      .mockResolvedValueOnce({ faces: [] }) // reference-cover landmark step
      .mockResolvedValueOnce({ faces: [bigFace()] }); // candidate photo

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result.error).toBe('low_confidence');
    expect(result.similarity).toBeCloseTo(0, 5);
  });

  test('with multiple faces in the photo, picks the crop of whichever one best matches the reference', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]) }) // reference
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'stranger-crop-b64' }) // face 1: unrelated
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'correct-person-crop-b64' }); // face 2: the actual match
    AIService.faceDetector.detectFaces
      .mockResolvedValueOnce({ faces: [] }) // reference-cover landmark step
      .mockResolvedValueOnce({ faces: [bigFace(), bigFace()] }); // candidate photo

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result.croppedImageBase64).toBe('correct-person-crop-b64');
  });

  test('returns detection_failed when face detection throws for the candidate photo', async () => {
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValue({ embedding: b64OfVector([1, 0, 0]) });
    AIService.faceDetector.detectFaces
      .mockResolvedValueOnce({ faces: [] }) // reference-cover landmark step succeeds
      .mockRejectedValueOnce(new Error('native crash')); // candidate photo detection fails

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'detection_failed' });
  });
});
