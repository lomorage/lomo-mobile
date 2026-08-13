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

function findPhotoTile(root) {
  return root.findAll(n => n.type === TouchableOpacity && n.props.onLongPress)
    .find(n => n.props.onPress && n.props.onPress.toString().includes('handleAssetPress'));
}

// Long-pressing a photo shows a confirm Alert; simulate the user tapping
// its "Set as Cover" action button rather than driving Alert UI directly.
function confirmSetCoverAlert() {
  const call = Alert.alert.mock.calls.find(c => c[0] === 'Set as Cover');
  const confirmButton = call[2].find(b => b.text === 'Set as Cover');
  return act(async () => { await confirmButton.onPress(); });
}

describe('AlbumDetailScreen - Set as Cover (long-press)', () => {
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

  test('long-pressing a photo in a face album prompts to confirm, then downloads, extracts, and saves the new cover', async () => {
    AIService.extractBestMatchingFaceCrop.mockResolvedValue({ croppedImageBase64: 'new-crop-b64', similarity: 0.9 });
    RemoteAlbumService.updateAlbumCover.mockResolvedValue(true);

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const photoTile = findPhotoTile(component.root);
    expect(photoTile).toBeDefined();
    act(() => { photoTile.props.onLongPress(); });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Set as Cover',
      expect.stringContaining('face'),
      expect.any(Array)
    );
    await confirmSetCoverAlert();
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

  test('still works via long-press when the album has no existing cover yet, as long as the photo has one face', async () => {
    RemoteAlbumService._findAlbumInTree.mockReturnValue({ info: { id: '1', coverImage: null } });
    AIService.extractBestMatchingFaceCrop.mockResolvedValue({ croppedImageBase64: 'first-cover-b64', similarity: null });
    RemoteAlbumService.updateAlbumCover.mockResolvedValue(true);

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const photoTile = findPhotoTile(component.root);
    act(() => { photoTile.props.onLongPress(); });
    await confirmSetCoverAlert();
    await flush();

    expect(AIService.extractBestMatchingFaceCrop).toHaveBeenCalledWith('file:///mock-cache/set_cover_hash1.jpg', null);
    expect(RemoteAlbumService.updateAlbumCover).toHaveBeenCalledWith('1', 'first-cover-b64');
  });

  test('shows an explanatory alert and does not save when no confident face match is found', async () => {
    AIService.extractBestMatchingFaceCrop.mockResolvedValue({ error: 'low_confidence', similarity: 0.1 });

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const photoTile = findPhotoTile(component.root);
    act(() => { photoTile.props.onLongPress(); });
    await confirmSetCoverAlert();
    await flush();

    expect(RemoteAlbumService.updateAlbumCover).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Cannot Set Cover', expect.stringContaining("doesn't look like a confident match"));
  });

  test('does not offer "Set as Cover" long-press for a non-face album', async () => {
    mockRouteParams = { albumId: '2', albumName: 'Vacation', fullPath: 'Vacation' };

    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const photoTile = component.root.findAll(n => n.type === TouchableOpacity && n.props.onPress)
      .find(n => n.props.onPress.toString().includes('handleAssetPress'));
    act(() => { photoTile.props.onLongPress(); });

    expect(Alert.alert).not.toHaveBeenCalled();
  });

  test('long-press does nothing while already in Select mode', async () => {
    let component;
    await act(async () => { component = renderer.create(<AlbumDetailScreen />); });
    await flush();

    const selectBtn = component.root.findAll(n => n.type === TouchableOpacity).find(btn => {
      try {
        return btn.findAll(c => c.type === Text && c.props.children === 'Select').length > 0;
      } catch (e) {
        return false;
      }
    });
    act(() => { selectBtn.props.onPress(); });
    await flush();

    const photoTile = findPhotoTile(component.root);
    act(() => { photoTile.props.onLongPress(); });

    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
