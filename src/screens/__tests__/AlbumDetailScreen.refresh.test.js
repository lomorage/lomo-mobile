import React from 'react';
import renderer, { act } from 'react-test-renderer';


jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props) => React.createElement(View, props) };
});

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock-cache/',
  downloadAsync: jest.fn(),
  deleteAsync: jest.fn().mockResolvedValue(),
}));

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { ScrollView } = require('react-native');
  return {
    FlashList: ({ data, renderItem }) => React.createElement(
      ScrollView, {}, (data || []).map((item, index) => renderItem({ item, index }))
    ),
  };
});

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { PlayCircle: Icon, Heart: Icon, CheckCircle2: Icon, Circle: Icon, MoreVertical: Icon, Trash2: Icon };
});

const mockNavigation = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: jest.fn(() => true) };
let mockRouteParams = { albumId: '1', albumName: 'alice', fullPath: '/Faces/alice' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
  useFocusEffect: (cb) => { require('react').useEffect(() => { const cleanup = cb(); return cleanup; }, []); },
}));

jest.mock('../../services/RemoteAlbumService', () => ({
  __esModule: true,
  default: {
    getAlbumAssets: jest.fn().mockResolvedValue(['hash1']),
    _findAlbumInTree: jest.fn(),
    updateAlbumCover: jest.fn(),
  },
}));
jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: { getSession: () => mockSession },
}));
let mockSession = 1;
jest.mock('../../services/NetworkQueue', () => ({ __esModule: true, default: { cancelGroup: jest.fn() } }));
jest.mock('../../services/AssetDBService', () => ({
  __esModule: true,
  default: { getAssetsByHashes: jest.fn().mockResolvedValue([{ hash: 'hash1', id: '1', mediaType: 'photo' }]) },
}));
jest.mock('../../store/GalleryStore', () => ({ __esModule: true, default: { setAssets: jest.fn() } }));
jest.mock('../../services/MediaService', () => ({
  __esModule: true,
  default: { getPreviewUrl: jest.fn(() => 'http://server/preview/hash1') },
}));
jest.mock('../../services/AIService', () => ({
  __esModule: true,
  default: { extractBestMatchingFaceCrop: jest.fn() },
}));

const AlbumDetailScreen = require('../AlbumDetailScreen').default;
const RemoteAlbumService = require('../../services/RemoteAlbumService').default;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('AlbumDetailScreen - rows updated elsewhere', () => {
  const AssetDBService = require('../../services/AssetDBService').default;
  const GalleryStore = require('../../store/GalleryStore').default;
  const { DeviceEventEmitter } = require('react-native');

  beforeEach(() => jest.clearAllMocks());

  test('an open album reads its rows again, so the detail view gets the original name', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    expect(GalleryStore.setAssets).toHaveBeenLastCalledWith([expect.objectContaining({ originalName: undefined })], 'album_1');
    const serverCalls = RemoteAlbumService.getAlbumAssets.mock.calls.length;

    AssetDBService.getAssetsByHashes.mockResolvedValueOnce([{ hash: 'hash1', id: '1', mediaType: 'photo', originalName: 'IMG_1.HEIC' }]);
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    await flush();

    expect(GalleryStore.setAssets).toHaveBeenLastCalledWith([expect.objectContaining({ hash: 'hash1', originalName: 'IMG_1.HEIC' })], 'album_1');
    expect(RemoteAlbumService.getAlbumAssets).toHaveBeenCalledTimes(serverCalls); // no server call
    act(() => tree.unmount());
  });

  test('an earlier refresh that finishes last does not put the old rows back', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();

    let finishEarlier;
    AssetDBService.getAssetsByHashes
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishEarlier = () => resolve([{ hash: 'hash1', id: '1', mediaType: 'photo', originalName: null }]);
      }))
      .mockResolvedValueOnce([{ hash: 'hash1', id: '1', mediaType: 'photo', originalName: 'IMG_1.HEIC' }]);
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    await flush();
    await act(async () => { finishEarlier(); });
    await flush();

    expect(GalleryStore.setAssets).toHaveBeenLastCalledWith([expect.objectContaining({ originalName: 'IMG_1.HEIC' })], 'album_1');
    act(() => tree.unmount());
  });

  const named = (originalName) => [{ hash: 'hash1', id: '1', mediaType: 'photo', originalName }];
  const blockedRead = () => {
    let finish;
    AssetDBService.getAssetsByHashes.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    return (rows) => act(async () => { finish(rows); });
  };

  test("a refresh still reading when the album is left doesn't write the shared cache", async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    const finish = blockedRead();
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    act(() => tree.unmount());
    GalleryStore.setAssets.mockClear();

    await finish(named('OLD_ACCOUNT.HEIC'));
    await flush();

    expect(GalleryStore.setAssets).not.toHaveBeenCalled();
  });

  test("a load still running when the album is left doesn't write the shared cache", async () => {
    let tree;
    const finish = blockedRead();
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    act(() => tree.unmount());

    await finish(named('OLD_ACCOUNT.HEIC'));
    await flush();

    expect(GalleryStore.setAssets).not.toHaveBeenCalled();
  });

  test('a read started before a sign-in change writes nothing', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    GalleryStore.setAssets.mockClear();
    const finish = blockedRead();
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    mockSession = 2;

    await finish(named('OLD_ACCOUNT.HEIC'));
    await flush();

    expect(GalleryStore.setAssets).not.toHaveBeenCalled();
    mockSession = 1;
    act(() => tree.unmount());
  });

  test('a refresh during a full load runs after it, so the load cannot put old rows back', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    const finishLoad = blockedRead(); // the reload's read: rows from before the name was learned
    await act(async () => { DeviceEventEmitter.emit('albumAssetsUpdated', '1'); });
    await flush();
    AssetDBService.getAssetsByHashes.mockResolvedValueOnce(named('IMG_1.HEIC'));
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });

    await finishLoad(named(null));
    await flush();

    expect(GalleryStore.setAssets).toHaveBeenLastCalledWith([expect.objectContaining({ originalName: 'IMG_1.HEIC' })], 'album_1');
    act(() => tree.unmount());
  });

  test("a refresh during a full load doesn't drop the photos the load found", async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    RemoteAlbumService.getAlbumAssets.mockResolvedValueOnce(['hash1', 'hash2']); // a photo added
    const finishLoad = blockedRead();
    await act(async () => { DeviceEventEmitter.emit('albumAssetsUpdated', '1'); });
    await flush();
    AssetDBService.getAssetsByHashes.mockResolvedValue(named('IMG_1.HEIC'));
    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });

    await finishLoad(named(null));
    await flush();

    const [items] = GalleryStore.setAssets.mock.calls[GalleryStore.setAssets.mock.calls.length - 1];
    expect(items.map((a) => a.hash)).toEqual(['hash1', 'hash2']);
    expect(items[0].originalName).toBe('IMG_1.HEIC');
    AssetDBService.getAssetsByHashes.mockResolvedValue([{ hash: 'hash1', id: '1', mediaType: 'photo' }]);
    act(() => tree.unmount());
  });

  test('after leaving the album, the event changes nothing', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<AlbumDetailScreen />); });
    await flush();
    act(() => tree.unmount());
    GalleryStore.setAssets.mockClear();

    await act(async () => { DeviceEventEmitter.emit('remoteAssetsUpdated'); });
    await flush();

    expect(GalleryStore.setAssets).not.toHaveBeenCalled();
  });
});
