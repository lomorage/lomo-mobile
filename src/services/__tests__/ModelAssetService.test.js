jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///data/files/',
    getInfoAsync: jest.fn(),
    makeDirectoryAsync: jest.fn(async () => {}),
    deleteAsync: jest.fn(async () => {}),
    moveAsync: jest.fn(async () => {}),
    createDownloadResumable: jest.fn(),
}));
jest.mock('../../../modules/expo-lomo-hasher', () => ({ hashFileAsync: jest.fn() }));

const { Platform } = require('react-native');
const FileSystem = require('expo-file-system/legacy');
const Hasher = require('../../../modules/expo-lomo-hasher');
const ModelAssetService = require('../ModelAssetService').default;
const { MODEL_FILES } = require('../ModelAssetService');

const present = (paths) =>
    FileSystem.getInfoAsync.mockImplementation(async (uri) => {
        const size = paths[uri];
        return size ? { exists: true, size } : { exists: false };
    });
const sizeOf = (name) => MODEL_FILES.find((m) => m.name === name).size;

beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
});
afterAll(() => {
    Platform.OS = 'ios';
});

test('iOS does not need the Android-only face model', async () => {
    Platform.OS = 'ios';
    const all = {};
    for (const m of MODEL_FILES.filter((f) => !f.androidOnly)) all[`file:///data/files/models/${m.name}`] = m.size;
    present(all);
    await expect(ModelAssetService.isReady()).resolves.toBe(true);
    await expect(ModelAssetService.getModelPath('w600k_r50.onnx')).rejects.toThrow('not downloaded');
});

test('state moves idle -> downloading -> ready and notifies subscribers', async () => {
    present({});
    FileSystem.createDownloadResumable.mockImplementation((url, dest) => ({
        downloadAsync: async () => ({ status: 200, uri: dest }),
    }));
    Hasher.hashFileAsync.mockImplementation(async (tmp) =>
        MODEL_FILES.find((m) => tmp.endsWith(`${m.name}.part`)).sha1);
    const seen = [];
    const unsubscribe = ModelAssetService.subscribe((st) => seen.push(st.status));

    await ModelAssetService.ensureModels();
    unsubscribe();

    expect(seen[0]).toBe('downloading');
    expect(seen[seen.length - 1]).toBe('ready');
    expect(ModelAssetService.getState().status).toBe('ready');
});

test('reuses the copy earlier builds left in the documents root', async () => {
    present({ 'file:///data/files/w600k_r50.onnx': sizeOf('w600k_r50.onnx') });
    await expect(ModelAssetService.getModelPath('w600k_r50.onnx')).resolves.toBe('/data/files/w600k_r50.onnx');
});

test('a wrong-size file does not count as present', async () => {
    present({ 'file:///data/files/models/w600k_r50.onnx': 5 });
    await expect(ModelAssetService.getModelPath('w600k_r50.onnx')).rejects.toThrow('not downloaded');
    await expect(ModelAssetService.isReady()).resolves.toBe(false);
});

test('downloads every missing file, verifies the hash and moves it into place', async () => {
    present({});
    FileSystem.createDownloadResumable.mockImplementation((url, dest) => ({
        downloadAsync: async () => ({ status: 200, uri: dest }),
    }));
    Hasher.hashFileAsync.mockImplementation(async (tmp) =>
        MODEL_FILES.find((m) => tmp.endsWith(`${m.name}.part`)).sha1);
    const progress = jest.fn();

    await ModelAssetService.ensureModels(progress);

    expect(FileSystem.moveAsync).toHaveBeenCalledTimes(MODEL_FILES.length);
    const urls = FileSystem.createDownloadResumable.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://lomorage.com/models/v1/visual_quant.onnx');
    expect(urls).toContain('https://github.com/lomorage/homepage/releases/download/models-v1/w600k_r50.onnx');
    const total = MODEL_FILES.reduce((s, m) => s + m.size, 0);
    expect(progress).toHaveBeenLastCalledWith({ downloadedBytes: total, totalBytes: total });
});

test('a checksum mismatch discards the file and fails', async () => {
    present({});
    FileSystem.createDownloadResumable.mockImplementation((url, dest) => ({
        downloadAsync: async () => ({ status: 200, uri: dest }),
    }));
    Hasher.hashFileAsync.mockResolvedValue('deadbeef');

    await expect(ModelAssetService.ensureModels()).rejects.toThrow('checksum');
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

test('an HTTP error fails without moving anything', async () => {
    present({});
    FileSystem.createDownloadResumable.mockImplementation(() => ({
        downloadAsync: async () => ({ status: 404 }),
    }));
    await expect(ModelAssetService.ensureModels()).rejects.toThrow('HTTP 404');
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(ModelAssetService.getState()).toMatchObject({ status: 'error' });
});

test('only missing files are fetched', async () => {
    const paths = {};
    for (const m of MODEL_FILES.slice(1)) paths[`file:///data/files/models/${m.name}`] = m.size;
    present(paths);
    FileSystem.createDownloadResumable.mockImplementation((url, dest) => ({
        downloadAsync: async () => ({ status: 200, uri: dest }),
    }));
    Hasher.hashFileAsync.mockResolvedValue(MODEL_FILES[0].sha1);

    await ModelAssetService.ensureModels();
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
});
