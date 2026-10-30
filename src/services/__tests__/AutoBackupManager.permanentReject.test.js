// What a file the server refuses outright must cost the backup: one attempt, then nothing.
// Before this, an upload error of any kind went back on the queue and counted towards the
// circuit breaker, so a single file lomod had no handler for could be re-sent for as long as
// the app ran and eventually stop the backup with a network message.
import AutoBackupManager from '../AutoBackupManager';
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
jest.mock('../UploadService', () => ({ uploadAsset: jest.fn() }));
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
const AssetDBService = require('../AssetDBService').default;

const refusal = (message = 'Not implemented: extension: avif') => {
    const err = new Error(message);
    err.httpStatus = 400;
    err.permanentReject = true;
    return err;
};

describe('a file the server refuses for good', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AutoBackupManager.isPaused = false;
        AutoBackupManager.isBackingUp = false;
        AutoBackupManager.currentIndex = 0;
        AutoBackupManager.queue = [];
        AutoBackupManager.consecutiveErrors = 0;
        AutoBackupManager.rejectedSessionCount = 0;
        AutoBackupManager.autoBackupEnabled = true;
        AutoBackupManager.activeAssetIds = new Set();
        SyncService.localHashCache = {};
        GalleryStore.setAssets([]);
    });

    afterEach(() => {
        if (AutoBackupManager._retryTimer) {
            clearTimeout(AutoBackupManager._retryTimer);
            AutoBackupManager._retryTimer = null;
        }
    });

    test('is attempted once and not put back on the queue', async () => {
        const asset = { id: 'avif', status: 'local', hash: 'h-avif' };
        SyncService.localHashCache['avif'] = { hash: 'h-avif', uploaded: false };
        UploadService.uploadAsset.mockRejectedValue(refusal());
        AutoBackupManager.queue = [asset];

        await AutoBackupManager.startBackup();

        // One attempt for the whole session: a re-queue would show up as a second call.
        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
        expect(AssetDBService.markUploadRejected).toHaveBeenCalledWith('avif', 'Not implemented: extension: avif');
    });

    test('does not count towards the circuit breaker that pauses the whole backup', async () => {
        // Five transient failures trip it on purpose; five refusals must not, or one unusable
        // file stops every other photo from being backed up.
        const assets = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, status: 'local', hash: `h${i}` }));
        for (const a of assets) SyncService.localHashCache[a.id] = { hash: a.hash, uploaded: false };
        UploadService.uploadAsset.mockRejectedValue(refusal());
        AutoBackupManager.queue = assets;

        await AutoBackupManager.startBackup();

        expect(AutoBackupManager.consecutiveErrors).toBe(0);
        expect(AutoBackupManager.isPaused).toBe(false);
        expect(AutoBackupManager.pauseReason).toBeNull();
        expect(AutoBackupManager.rejectedSessionCount).toBe(5);
    });

    test('does not block the photos queued behind it', async () => {
        const bad = { id: 'avif', status: 'local', hash: 'h-avif' };
        const good = { id: 'jpg', status: 'local', hash: 'h-jpg' };
        SyncService.localHashCache['avif'] = { hash: 'h-avif', uploaded: false };
        SyncService.localHashCache['jpg'] = { hash: 'h-jpg', uploaded: false };
        UploadService.uploadAsset.mockImplementation(async (asset) => {
            if (asset.id === 'avif') throw refusal();
            return { success: true, hash: asset.hash };
        });
        AutoBackupManager.queue = [bad, good];

        await AutoBackupManager.startBackup();

        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(2);
        expect(AutoBackupManager.completedSessionCount).toBe(1);
    });

    test('is left out of the queue on the next pass, even though it is still local', async () => {
        // The failure used to live only in memory, and the next library compare handed the asset
        // straight back to the queue. It is the gallery still calling it 'local' that made the
        // retry eternal, so the refusal has to be what keeps it out.
        SyncService.localHashCache['avif'] = { hash: 'h-avif', uploaded: false, uploadRejected: true };
        GalleryStore.setAssets([
            { id: 'avif', status: 'local', hash: 'h-avif' },
            { id: 'jpg', status: 'local', hash: 'h-jpg' },
        ]);
        UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'h-jpg' });

        AutoBackupManager.syncQueueWithGallery();

        expect(AutoBackupManager.queue.map(a => a.id)).toEqual(['jpg']);
    });

    test('a session of nothing but refused files ends instead of restarting', async () => {
        // startBackup restarts for local assets that showed up meanwhile. A refused asset stays
        // local for good, so counting it as remaining work restarts the session forever.
        const asset = { id: 'avif', status: 'local', hash: 'h-avif' };
        SyncService.localHashCache['avif'] = { hash: 'h-avif', uploaded: false };
        GalleryStore.setAssets([asset]);
        UploadService.uploadAsset.mockRejectedValue(refusal());
        AutoBackupManager.queue = [asset];

        await AutoBackupManager.startBackup();

        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(1);
        expect(AutoBackupManager.isBackingUp).toBe(false);
    });

    test('an ordinary upload error still goes back on the queue and is retried', async () => {
        // The retry path has to stay intact for the failures that really are transient.
        const asset = { id: 'flaky', status: 'local', hash: 'h-flaky' };
        SyncService.localHashCache['flaky'] = { hash: 'h-flaky', uploaded: false };
        UploadService.uploadAsset
            .mockRejectedValueOnce(new Error('Network request failed'))
            .mockResolvedValue({ success: true, hash: 'h-flaky' });
        AutoBackupManager.queue = [asset];

        await AutoBackupManager.startBackup();

        expect(UploadService.uploadAsset).toHaveBeenCalledTimes(2); // pushed back, then succeeded
        expect(AutoBackupManager.completedSessionCount).toBe(1);
        expect(AssetDBService.markUploadRejected).not.toHaveBeenCalled();
    });

    test('retryRejectedUploads offers them to the queue again', async () => {
        AssetDBService.clearUploadRejected.mockResolvedValue(1);
        SyncService.localHashCache['avif'] = { hash: 'h-avif', uploaded: false, uploadRejected: true };
        GalleryStore.setAssets([{ id: 'avif', status: 'local', hash: 'h-avif' }]);
        UploadService.uploadAsset.mockResolvedValue({ success: true, hash: 'h-avif' });

        const cleared = await AutoBackupManager.retryRejectedUploads();

        expect(cleared).toBe(1);
        expect(SyncService.localHashCache['avif'].uploadRejected).toBe(false);
        expect(AutoBackupManager.rejectedSessionCount).toBe(0);
    });
});
