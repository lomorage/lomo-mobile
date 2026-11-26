// A failure while getting an item's bytes off the phone (an iCloud-only original that won't
// download) has to be told apart from a network or server failure, so the backup can set the
// item aside instead of tripping its circuit breaker. And a failed upload must not leave its
// full-size temp copy behind on a phone that is short of space.
jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///mock-cache/',
    makeDirectoryAsync: jest.fn(async () => {}),
    deleteAsync: jest.fn(async () => {}),
    getInfoAsync: jest.fn(async () => ({ exists: true, size: 1234 })),
    copyAsync: jest.fn(async () => {}),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../MediaService', () => ({
    getAssetInfo: jest.fn(),
    isLivePhotoAsync: jest.fn(async () => false),
    normalizeUri: jest.fn((u) => u),
    calculateHash: jest.fn(async () => 'abc123'),
}));
jest.mock('../AuthService', () => ({ getServerUrl: jest.fn(() => 'http://server'), getToken: jest.fn(() => 'tok') }));
jest.mock('../../../modules/expo-lomo-hasher', () => ({ sliceFileAsync: jest.fn(), sliceFileRangeAsync: jest.fn() }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn() }));
jest.mock('../SyncService', () => ({
    __esModule: true,
    default: { loadLocalHashCache: jest.fn(async () => {}), localHashCache: {} },
}));
jest.mock('../AssetDBService', () => ({
    __esModule: true,
    default: { updateAssetHash: jest.fn(async () => {}), getExifTakenTime: jest.fn(async () => null) },
}));

import * as FileSystem from 'expo-file-system/legacy';
import MediaService from '../MediaService';
import UploadService from '../UploadService';

const iosAsset = { id: 'ABC-1/L0/001', uri: 'ph://ABC-1/L0/001', status: 'local', modificationTime: 1 };

describe('UploadService failures while reading the item', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('an item the library cannot hand over is marked localReadFailed', async () => {
        MediaService.getAssetInfo.mockResolvedValue(null);

        await expect(UploadService._executeUpload(iosAsset)).rejects.toMatchObject({ localReadFailed: true });
    });

    test('a copy that fails (iCloud download refused) is marked localReadFailed', async () => {
        MediaService.getAssetInfo.mockResolvedValue({ uri: iosAsset.uri, filename: 'IMG_1.HEIC', creationTime: 1 });
        FileSystem.getInfoAsync.mockResolvedValueOnce({ exists: false });
        FileSystem.copyAsync.mockRejectedValueOnce(new Error('The operation couldn’t be completed. (PHPhotosErrorDomain error 3164.)'));

        await expect(UploadService._executeUpload(iosAsset)).rejects.toMatchObject({ localReadFailed: true });
    });

    test('a failure talking to the server is not marked localReadFailed, and the temp copy is kept for the retry', async () => {
        MediaService.getAssetInfo.mockResolvedValue({ uri: iosAsset.uri, filename: 'IMG_1.HEIC', creationTime: 1 });
        jest.spyOn(UploadService, 'checkUploadStatus').mockRejectedValue(new Error('Network request failed'));

        const error = await UploadService._executeUpload(iosAsset).catch((e) => e);

        expect(error.message).toBe('Network request failed');
        expect(error.localReadFailed).toBeUndefined();
        expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///mock-cache/ABC1L0001.raw', expect.anything());
    });

    test('a copy that failed partway is deleted, so the next attempt does not reuse it', async () => {
        MediaService.getAssetInfo.mockResolvedValue({ uri: iosAsset.uri, filename: 'IMG_1.HEIC', creationTime: 1 });
        FileSystem.getInfoAsync.mockResolvedValueOnce({ exists: false });
        FileSystem.copyAsync.mockRejectedValueOnce(new Error('iCloud download failed'));

        await UploadService._executeUpload(iosAsset).catch(() => {});

        expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///mock-cache/ABC1L0001.raw', { idempotent: true });
    });
});
