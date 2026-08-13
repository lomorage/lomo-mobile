import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, TouchableOpacity, Text } from 'react-native';

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
  return { PlayCircle: Icon, Heart: Icon, CheckCircle2: Icon, Circle: Icon, MoreVertical: Icon, Trash2: Icon, UserCircle2: Icon };
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

import AlbumDetailScreen from '../AlbumDetailScreen';
import RemoteAlbumService from '../../services/RemoteAlbumService';
import AIService from '../../services/AIService';
import MediaService from '../../services/MediaService';
const FileSystem = require('expo-file-system/legacy');

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function findButtonByText(root, text) {
  return root.findAll(n => n.type === TouchableOpacity).find(btn => {
    try {
      return btn.findAll(c => c.type === Text && c.props.children === text).length > 0;
    } catch (e) {
      return false;
    }
  });
}

async function enterSelectModeAndPickFirstPhoto(root) {
  const selectBtn = findButtonByText(root, 'Select');
  act(() => { selectBtn.props.onPress(); });
  await flush();

  const photoTile = root.findAll(n => n.type === TouchableOpacity && n.props.onPress)
    .find(n => n.props.onPress.toString().includes('handleAssetPress'));
  act(() => { photoTile.props.onPress(); });
  await flush();
}

describe('AlbumDetailScreen - Set as Cover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteParams = { albumId: '1', albumName: 'alice', fullPath: '/Faces/alice' };
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    RemoteAlbumService.getAlbumAssets.mockResolvedValue(['hash1']);
    RemoteAlbumService._findAlbumInTree.mockReturnValue({ info: { id: '1', coverImage: 'current-cover-b64' } });
    FileSystem.downloadAsync.mockResolvedValue({ status: 200, uri: 'file:///mock-cache/set_cover_hash1.jpg' });
  });

  afterEach(() => {
    if (Alert.alert.mockRestore) Alert.alert.mockRestore();
  });

  test('downloads the large preview, extracts a matching face, and saves it as the new cover', async () => {
    AIService.extractBestMatchingFaceCrop.mockResolvedValue({ croppedImageBase64: 'new-crop-b64', similarity: 0.9 });
    RemoteAlbumService.updateAlbumCover.mockResolvedValue(true);

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    await enterSelectModeAndPickFirstPhoto(component.root);

    const setCoverBtn = findButtonByText(component.root, 'Set as Cover');
    expect(setCoverBtn).toBeDefined();
    await act(async () => { await setCoverBtn.props.onPress(); });
    await flush();

    // Large (640px) tier requested, not the default grid thumbnail.
    expect(MediaService.getPreviewUrl).toHaveBeenCalledWith('hash1', 'photo', true);
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith('http://server/preview/hash1', expect.stringContaining('set_cover_hash1.jpg'));
    expect(AIService.extractBestMatchingFaceCrop).toHaveBeenCalledWith(
      'file:///mock-cache/set_cover_hash1.jpg', 'current-cover-b64'
    );
    expect(RemoteAlbumService.updateAlbumCover).toHaveBeenCalledWith('1', 'new-crop-b64');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining('set_cover_hash1.jpg'),
      expect.objectContaining({ idempotent: true })
    );
  });

  test('shows an explanatory alert and does not save when no confident face match is found', async () => {
    AIService.extractBestMatchingFaceCrop.mockResolvedValue({ error: 'low_confidence', similarity: 0.1 });

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    await enterSelectModeAndPickFirstPhoto(component.root);

    const setCoverBtn = findButtonByText(component.root, 'Set as Cover');
    await act(async () => { await setCoverBtn.props.onPress(); });
    await flush();

    expect(RemoteAlbumService.updateAlbumCover).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Cannot Set Cover', expect.stringContaining("doesn't look like a confident match"));
  });

  test('does not offer "Set as Cover" for a non-face album', async () => {
    mockRouteParams = { albumId: '2', albumName: 'Vacation', fullPath: 'Vacation' };

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const selectBtn = findButtonByText(component.root, 'Select');
    act(() => { selectBtn.props.onPress(); });
    await flush();

    expect(findButtonByText(component.root, 'Set as Cover')).toBeUndefined();
  });
});
