// Items the phone can't hand over (an original kept only in iCloud that won't download) must
// not stall the backup. They used to count as network errors: five in a row tripped the circuit
// breaker, resume() zeroed the backoff and rebuilt the queue in library order with the same items
// first, so the backup retried them every 5s forever and nothing behind them was uploaded.
import AutoBackupManager, { UNREADABLE_RETRY_MS } from '../AutoBackupManager';
import GalleryStore from '../../store/GalleryStore';
import UploadService from '../UploadService';

jest.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: jest.fn(() => ({ remove: jest.fn() })), emit: jest.fn() },
    AppState: { addEventListener: jest.fn(), currentState: 'active' },
}));

jest.mock('expo-notifications', () => ({
    dismissAllNotificationsAsync: jest.fn(async () => {}),
    scheduleNotificationAsync: jest.fn(async () => {}),
    getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    setNotificationHandler: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn() }));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn(async () => false) }));
jest.mock('expo-background-task', () => ({ registerTaskAsync: jest.fn(async () => {}) }));
jest.mock('expo-battery', () => ({
    getBatteryStateAsync: jest.fn(async () => 'CHARGING'),
    addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
    BatteryState: { UNPLUGGED: 'UNPLUGGED', CHARGING: 'CHARGING', FULL: 'FULL', UNKNOWN: 'UNKNOWN' },
}));
jest.mock('expo-network', () => ({
    getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, type: 'WIFI' })),
    NetworkStateType: { WIFI: 'WIFI' },
}));
jest.mock('expo-location', () => ({}));
jest.mock('../UploadService', () => ({ uploadAsset: jest.fn(), cancelUpload: jest.fn() }));
jest.mock('../../../modules/expo-background-keepalive', () => ({ startKeepAlive: jest.fn(), stopKeepAlive: jest.fn() }));
jest.mock('../SyncService', () => ({
    __esModule: true,
    default: { fetchRemoteOverview: jest.fn(async () => {}), localHashCache: {} },
}));
jest.mock('../AssetDBService', () => ({
    __esModule: true,
    default: { markUploadRejected: jest.fn(async () => {}), clearUploadRejected: jest.fn(async () => 0) },
}));

const SyncService = require('../SyncService').default;

const unreadable = () => {
    const err = new Error('Could not read this item from the photo library (it may be stored only in iCloud).');
    err.localReadFailed = true;
    return err;
};

const localAsset = (id) => ({ id, status: 'local', hash: `h-${id}` });

describe('an item that cannot be read from the photo library', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AutoBackupManager.isPaused = false;
        AutoBackupManager.pauseReason = null;
        AutoBackupManager.isBackingUp = false;
        AutoBackupManager.currentIndex = 0;
        AutoBackupManager.queue = [];
        AutoBackupManager.consecutiveErrors = 0;
        AutoBackupManager.retryCount = 0;
        AutoBackupManager.rejectedIds = new Set();
        AutoBackupManager.unreadableIds = new Map();
        AutoBackupManager.autoBackupEnabled = true;
        AutoBackupManager.activeAssetIds = new Set();
        SyncService.localHashCache = {};
        GalleryStore.setAssets([]);
    });

    afterEach(() => {
        jest.useRealTimers();
        if (AutoBackupManager._retryTimer) {
            clearTimeout(AutoBackupManager._retryTimer);
            AutoBackupManager._retryTimer = null;
        }
    });

    test('five in a row do not trip the circuit breaker, and the photos behind them still upload', async () => {
        const icloud = Array.from({ length: 5 }, (_, i) => localAsset(`icloud${i}`));
        const good = localAsset('good');
        UploadService.uploadAsset.mockImplementation(async (asset) => {
            if (asset.id.startsWith('icloud')) throw unreadable();
            return { success: true, hash: asset.hash };
        });
        AutoBackupManager.queue = [...icloud, good];

        await AutoBackupManager.startBackup();

        expect(AutoBackupManager.isPaused).toBe(false);
        expect(AutoBackupManager.pauseReason).toBeNull();
        expect(AutoBackupManager.consecutiveErrors).toBe(0);
        expect(AutoBackupManager.completedSessionCount).toBe(1);
        // Tried once each: not pushed back on the queue.
        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(6);
        expect(AutoBackupManager._setAsideCount()).toBe(5);
    });

    test('a session of nothing but unreadable items ends instead of restarting', async () => {
        const asset = localAsset('icloud');
        GalleryStore.setAssets([asset]);
        UploadService.uploadAsset.mockRejectedValue(unreadable());
        AutoBackupManager.queue = [asset];

        await AutoBackupManager.startBackup();

        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
        expect(AutoBackupManager.isBackingUp).toBe(false);
    });

    test('sits out of the queue, then comes back after UNREADABLE_RETRY_MS', () => {
        const now = 1_000_000;
        const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
        AutoBackupManager.unreadableIds.set('icloud', now);
        AutoBackupManager.isPaused = true; // keep syncQueueWithGallery from starting a session
        GalleryStore.setAssets([localAsset('icloud'), localAsset('jpg')]);

        AutoBackupManager.syncQueueWithGallery();
        expect(AutoBackupManager.queue.map(a => a.id)).toEqual(['jpg']);

        spy.mockReturnValue(now + UNREADABLE_RETRY_MS);
        AutoBackupManager.syncQueueWithGallery();
        expect(AutoBackupManager.queue.map(a => a.id)).toEqual(['icloud', 'jpg']);
        spy.mockRestore();
    });

    test('a resume from the user offers the set-aside items again', () => {
        AutoBackupManager.unreadableIds.set('icloud', Date.now());
        AutoBackupManager.retryCount = 2;
        AutoBackupManager.isPaused = true;

        AutoBackupManager.resume();

        expect(AutoBackupManager.unreadableIds.size).toBe(0);
        expect(AutoBackupManager.retryCount).toBe(0);
    });
});

describe('circuit breaker backoff', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AutoBackupManager.isPaused = false;
        AutoBackupManager.isBackingUp = false;
        AutoBackupManager.queue = [];
        AutoBackupManager.currentIndex = 0;
        AutoBackupManager.retryCount = 0;
        AutoBackupManager.unreadableIds = new Map();
        AutoBackupManager.activeAssetIds = new Set();
        AutoBackupManager.autoBackupEnabled = true;
        GalleryStore.setAssets([]);
    });

    afterEach(() => {
        jest.useRealTimers();
        if (AutoBackupManager._retryTimer) {
            clearTimeout(AutoBackupManager._retryTimer);
            AutoBackupManager._retryTimer = null;
        }
    });

    test('waking from its own timer keeps the backoff step, so the next trip waits longer', async () => {
        jest.useFakeTimers();
        UploadService.uploadAsset.mockRejectedValue(new Error('Network request failed'));

        AutoBackupManager.consecutiveErrors = 4;
        await AutoBackupManager._uploadSingle(localAsset('a'));
        expect(AutoBackupManager.retryCount).toBe(1);
        expect(AutoBackupManager.pauseReason).toBe('Network error. Resuming in 5s...');

        jest.advanceTimersByTime(5000);
        expect(AutoBackupManager.isPaused).toBe(false);
        expect(AutoBackupManager.retryCount).toBe(1); // used to be zeroed here

        AutoBackupManager.isBackingUp = false;
        AutoBackupManager.consecutiveErrors = 4;
        await AutoBackupManager._uploadSingle(localAsset('b'));
        expect(AutoBackupManager.retryCount).toBe(2);
        expect(AutoBackupManager.pauseReason).toBe('Network error. Resuming in 30s...');
    });

    test('past the last step it keeps retrying every 2 minutes instead of stopping for good', async () => {
        jest.useFakeTimers();
        UploadService.uploadAsset.mockRejectedValue(new Error('Network request failed'));

        for (const [trip, wait] of [[1, 5000], [2, 30000], [3, 120000], [4, 120000], [5, 120000]]) {
            AutoBackupManager.isBackingUp = false;
            AutoBackupManager.consecutiveErrors = 4;
            await AutoBackupManager._uploadSingle(localAsset(`x${trip}`));
            expect(AutoBackupManager.retryCount).toBe(trip);
            expect(AutoBackupManager.pauseReason).toBe(`Network error. Resuming in ${wait / 1000}s...`);
            jest.advanceTimersByTime(wait);
            expect(AutoBackupManager.isPaused).toBe(false);
        }
    });
});
