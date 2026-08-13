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
  // Each `new RNMLKitFaceDetector(...)` call gets its own independent
  // detectFaces mock -- AIService constructs two instances (the strict
  // clustering one as `faceDetector`, and a lenient one as
  // `manualPickFaceDetector`), so tests can control each separately.
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

  test('returns detection_failed when the lenient (manual-pick) detector throws', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockRejectedValueOnce(new Error('native crash'));
    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'detection_failed' });
  });

  test('returns no_faces_found when the lenient detector finds nothing', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [] });
    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'no_faces_found' });
  });

  test('uses the lenient manualPickFaceDetector, not the strict clustering one, on the candidate photo', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'solo-crop-b64' });

    await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');

    expect(AIService.manualPickFaceDetector.detectFaces).toHaveBeenCalledWith('file://photo.jpg');
    expect(AIService.faceDetector.detectFaces).not.toHaveBeenCalled();
  });

  test('a single detected face is used directly, with no comparison against the current cover', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'solo-crop-b64' });

    // No current cover at all -- must still succeed, since there's no ambiguity to resolve.
    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', null);

    expect(result).toEqual({ croppedImageBase64: 'solo-crop-b64', similarity: null });
    // _computeCoverEmbedding (which needs the reference cover) must never run.
    expect(AIService.faceDetector.detectFaces).not.toHaveBeenCalled();
  });

  test('a single detected face succeeds even when the current cover would have been a bad reference', async () => {
    // Regression test: the whole point of picking a new cover is sometimes to
    // *fix* a cover that's showing the wrong person. Requiring the new photo
    // to match that wrong cover would make it permanently unfixable.
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync.mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'the-real-person-crop-b64' });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'wrong-person-cover-b64');

    expect(result.croppedImageBase64).toBe('the-real-person-crop-b64');
    expect(ExpoLomoHasher.encodeFaceEmbeddingAsync).toHaveBeenCalledTimes(1); // only the candidate face, never the reference cover
  });

  test('multiple faces: returns multiple_faces_no_reference when there is no current cover to disambiguate with', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace(), bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'a-crop-b64' })
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'b-crop-b64' });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', null);
    expect(result).toEqual({ error: 'multiple_faces_no_reference' });
  });

  test('multiple faces: picks whichever detected face best matches the current cover', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace(), bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'stranger-crop-b64' }) // face 1: unrelated
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'correct-person-crop-b64' }) // face 2: the match
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]) }); // reference cover embedding (uses the strict faceDetector)
    AIService.faceDetector.detectFaces.mockResolvedValueOnce({ faces: [] }); // reference-cover landmark step

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result.croppedImageBase64).toBe('correct-person-crop-b64');
    expect(result.similarity).toBeCloseTo(1, 5);
  });

  test('multiple faces: returns low_confidence when the best candidate does not resemble the reference cover', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace(), bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'a-crop-b64' })
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 0, 1]), croppedImage: 'b-crop-b64' })
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]) }); // reference cover, orthogonal to both candidates
    AIService.faceDetector.detectFaces.mockResolvedValueOnce({ faces: [] });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result.error).toBe('low_confidence');
  });

  test('multiple faces: returns reference_embedding_failed when the current cover itself cannot be embedded', async () => {
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [bigFace(), bigFace()] });
    ExpoLomoHasher.encodeFaceEmbeddingAsync
      .mockResolvedValueOnce({ embedding: b64OfVector([0, 1, 0]), croppedImage: 'a-crop-b64' })
      .mockResolvedValueOnce({ embedding: b64OfVector([1, 0, 0]), croppedImage: 'b-crop-b64' })
      .mockResolvedValueOnce({ embedding: null }); // reference cover fails to embed
    AIService.faceDetector.detectFaces.mockResolvedValueOnce({ faces: [] });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'reference_embedding_failed' });
  });

  test('returns no_valid_faces when every detected face is filtered out as too small', async () => {
    const tinyFace = { frame: { origin: { x: 0, y: 0 }, size: { x: 10, y: 10 } } };
    AIService.manualPickFaceDetector.detectFaces.mockResolvedValueOnce({ faces: [tinyFace] });

    const result = await AIService.extractBestMatchingFaceCrop('file://photo.jpg', 'cover-b64');
    expect(result).toEqual({ error: 'no_valid_faces' });
    expect(ExpoLomoHasher.encodeFaceEmbeddingAsync).not.toHaveBeenCalled();
  });
});
