import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ExpoLomoHasher from '../../modules/expo-lomo-hasher';

// AI models are downloaded on demand instead of being bundled in the app (they were
// ~350MB on Android and ~150MB on iOS, which kept low-storage phones from installing it).
//
// Files go to documentDirectory/models/. Earlier Android builds copied the bundled models
// to the documentDirectory root (the native module's resolveModelPath did this), so a file
// there with the right size is reused instead of downloading it again.

// lomorage.com is GitHub Pages behind Cloudflare, which rejects files over 100MB, so the
// face model is a GitHub Release asset instead (see its own url below).
export const MODEL_CDN_BASE_URL =
    process.env.EXPO_PUBLIC_MODEL_CDN_URL || 'https://lomorage.com/models/v1';

// size/sha1 pin the exact files the native code was built against. The face model is
// Android-only: the iOS native module has no face encoder.
export const MODEL_FILES = [
    { name: 'visual_quant.onnx', size: 88521003, sha1: '42e8ce17f0b5c367485911cbf442f33760ebd710' },
    { name: 'textual_quant.onnx', size: 63997098, sha1: '01c90b49fb72a915e51b0e9b1a41db52794603c8' },
    { name: 'w600k_r50.onnx', size: 174383860, sha1: 'ae27d88a5a23c53bb544e2f91ffcd169f73fb24f', androidOnly: true,
        url: 'https://github.com/lomorage/homepage/releases/download/models-v1/w600k_r50.onnx' },
    { name: 'vocab.json', size: 1109372, sha1: 'c5f9b7ca689e0dbfb8617d155be46ed9867a63e0' },
    { name: 'merges.txt', size: 573514, sha1: '49b2f6ef6eb9696f0a127ba4c870c6b2e408dfc4' },
];

const requiredModels = () => MODEL_FILES.filter((m) => !m.androidOnly || Platform.OS === 'android');
const modelsDir = () => `${FileSystem.documentDirectory}models/`;
const stripScheme = (uri) => uri.replace(/^file:\/\//, '');
const byName = (name) => MODEL_FILES.find((m) => m.name === name);

let inFlight = null;
let state = { status: 'idle', downloadedBytes: 0, totalBytes: 0, error: null };
const listeners = new Set();

function setState(next) {
    state = { ...state, ...next };
    listeners.forEach((fn) => fn(state));
}

async function existingPath(model) {
    for (const uri of [`${modelsDir()}${model.name}`, `${FileSystem.documentDirectory}${model.name}`]) {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && info.size === model.size) return stripScheme(uri);
    }
    return null;
}

const ModelAssetService = {
    // Total download size of the files this platform needs, for "about N MB" wording.
    getTotalBytes() {
        return requiredModels().reduce((sum, m) => sum + m.size, 0);
    },

    getState() {
        return state;
    },

    // Calls listener on every change; returns the unsubscribe function.
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    // Path to hand to the native encoders.
    async getModelPath(name) {
        const model = byName(name);
        if (!model) throw new Error(`Unknown model file: ${name}`);
        const found = await existingPath(model);
        if (!found) throw new Error(`Model not downloaded: ${name}`);
        return found;
    },

    async isReady() {
        return (await this.getMissing()).length === 0;
    },

    async getMissing() {
        const missing = [];
        for (const model of requiredModels()) {
            if (!(await existingPath(model))) missing.push(model);
        }
        return missing;
    },

    // Downloads whatever is missing. Safe to call concurrently (calls share one run).
    // Each file is hash-checked, then moved into place, so a partial file is never used.
    async ensureModels(onProgress) {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const missing = await this.getMissing();
            if (missing.length === 0) {
                setState({ status: 'ready', error: null });
                return true;
            }
            await FileSystem.makeDirectoryAsync(modelsDir(), { intermediates: true });
            const totalBytes = missing.reduce((sum, m) => sum + m.size, 0);
            let doneBytes = 0;
            const report = (downloadedBytes) => {
                setState({ status: 'downloading', downloadedBytes, totalBytes, error: null });
                onProgress?.({ downloadedBytes, totalBytes });
            };
            report(0);
            try {
                for (const model of missing) {
                    const tmp = `${modelsDir()}${model.name}.part`;
                    const dest = `${modelsDir()}${model.name}`;
                    const resumable = FileSystem.createDownloadResumable(
                        model.url || `${MODEL_CDN_BASE_URL}/${model.name}`,
                        tmp,
                        {},
                        (p) => report(doneBytes + p.totalBytesWritten)
                    );
                    const result = await resumable.downloadAsync();
                    if (!result || result.status !== 200) {
                        await FileSystem.deleteAsync(tmp, { idempotent: true });
                        throw new Error(`Model download failed (${model.name}): HTTP ${result?.status}`);
                    }
                    const hash = await ExpoLomoHasher.hashFileAsync(tmp);
                    if (hash !== model.sha1) {
                        await FileSystem.deleteAsync(tmp, { idempotent: true });
                        throw new Error(`Model checksum mismatch: ${model.name}`);
                    }
                    await FileSystem.moveAsync({ from: tmp, to: dest });
                    doneBytes += model.size;
                    report(doneBytes);
                }
            } catch (e) {
                setState({ status: 'error', error: e.message });
                throw e;
            }
            setState({ status: 'ready', error: null });
            return true;
        })().finally(() => {
            inFlight = null;
        });
        return inFlight;
    },
};

export default ModelAssetService;
