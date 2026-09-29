import MediaService from '../MediaService';
import AuthService from '../AuthService';
import * as MediaLibrary from 'expo-media-library';

jest.mock('../../../modules/expo-lomo-hasher', () => ({
  hashFileAsync: jest.fn(),
  isLivePhotoAsync: jest.fn(),
  prepareLivePhotoBackupAsync: jest.fn(),
  extractVideoFromZipAsync: jest.fn(),
  getLocalLivePhotoVideoUriAsync: jest.fn(),
}));

// Mock AuthService since getPreviewUrl relies on it
jest.mock('../AuthService', () => ({
  getServerUrl: jest.fn(),
  getToken: jest.fn(),
}));

describe('MediaService.getPreviewUrl', () => {
  beforeEach(() => {
    AuthService.getServerUrl.mockReturnValue('http://mock-server');
    AuthService.getToken.mockReturnValue('mock-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return null if hash is not provided', () => {
    expect(MediaService.getPreviewUrl(null, 'image')).toBeNull();
    expect(MediaService.getPreviewUrl(undefined, 'video')).toBeNull();
  });

  it('should request width=320 for image thumbnail (avoid dynamic transcode)', () => {
    const url = MediaService.getPreviewUrl('hash123', 'image');
    expect(url).toBe('http://mock-server/preview/hash123?width=320&height=-1&token=mock-token');
  });

  it('should request width=640 for large image preview (avoid dynamic transcode)', () => {
    const url = MediaService.getPreviewUrl('hash123', 'image', true);
    expect(url).toBe('http://mock-server/preview/hash123?width=640&height=-1&token=mock-token');
  });

  it('should request width=480 for video thumbnail (avoid dynamic transcode)', () => {
    const url = MediaService.getPreviewUrl('hash456', 'video');
    expect(url).toBe('http://mock-server/preview/hash456?width=480&height=-1&token=mock-token');
  });

  it('should request width=480 for video even if isLarge is true', () => {
    // Videos only have 480 pre-generated, so it should not request 640
    const url = MediaService.getPreviewUrl('hash456', 'video', true);
    expect(url).toBe('http://mock-server/preview/hash456?width=480&height=-1&token=mock-token');
  });
});

describe('MediaService photo access helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the number of photos and videos visible to the app', async () => {
    jest.spyOn(MediaLibrary, 'getAssetsAsync').mockResolvedValue({
      assets: [{ id: 'visible-asset' }],
      totalCount: 7,
    });

    await expect(MediaService.getAccessibleAssetCount()).resolves.toBe(7);
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith({
      first: 1,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    });
  });

  it('opens the iOS limited-library picker', async () => {
    const picker = jest.spyOn(MediaLibrary, 'presentPermissionsPickerAsync').mockResolvedValue();

    await expect(MediaService.presentLimitedLibraryPicker()).resolves.toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('subscribes to iOS media-library changes', () => {
    const subscription = { remove: jest.fn() };
    const listener = jest.fn();
    const addListener = jest.spyOn(MediaLibrary, 'addListener').mockReturnValue(subscription);

    expect(MediaService.addLibraryChangeListener(listener)).toBe(subscription);
    expect(addListener).toHaveBeenCalledWith(listener);
  });
});
