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
  supportsWebpPreview: jest.fn(),
}));

describe('MediaService.getPreviewUrl', () => {
  beforeEach(() => {
    AuthService.getServerUrl.mockReturnValue('http://mock-server');
    AuthService.getToken.mockReturnValue('mock-token');
    AuthService.supportsWebpPreview.mockReturnValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return null if hash is not provided', () => {
    expect(MediaService.getPreviewUrl(null, 'image')).toBeNull();
    expect(MediaService.getPreviewUrl(undefined, 'video')).toBeNull();
  });

  it('requests the pre-generated 320px WebP for an image thumbnail', () => {
    const url = MediaService.getPreviewUrl('hash123', 'image');
    expect(url).toBe('http://mock-server/preview/hash123?width=320&height=-1&icodec=webp&token=mock-token');
  });

  it('requests the pre-generated 640px WebP for a large image preview', () => {
    const url = MediaService.getPreviewUrl('hash123', 'image', true);
    expect(url).toBe('http://mock-server/preview/hash123?width=640&height=-1&icodec=webp&token=mock-token');
  });

  it('uses the image preview sizes for a video thumbnail (480 is the mp4 preview, not an image)', () => {
    expect(MediaService.getPreviewUrl('hash456', 'video'))
      .toBe('http://mock-server/preview/hash456?width=320&height=-1&icodec=webp&token=mock-token');
    expect(MediaService.getPreviewUrl('hash456', 'video', true))
      .toBe('http://mock-server/preview/hash456?width=640&height=-1&icodec=webp&token=mock-token');
  });

  it('omits icodec (server default JPEG) when the server pre-generates JPEG', () => {
    AuthService.supportsWebpPreview.mockReturnValue(false);
    const url = MediaService.getPreviewUrl('hash123', 'image');
    expect(url).toBe('http://mock-server/preview/hash123?width=320&height=-1&token=mock-token');
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
