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
