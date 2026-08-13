import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, TouchableOpacity, Text } from 'react-native';
import { LomoCollection, LomoAlbum } from '../../models/LomoCollection';

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props) => React.createElement(View, props) };
});

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { ScrollView } = require('react-native');
  return {
    FlashList: ({ data, renderItem, ListEmptyComponent }) => {
      const empty = ListEmptyComponent ? (typeof ListEmptyComponent === 'function' ? ListEmptyComponent() : ListEmptyComponent) : null;
      return React.createElement(
        ScrollView,
        {},
        data && data.length > 0 ? data.map((item, index) => renderItem({ item, index })) : empty
      );
    },
  };
});

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { Folder: Icon, Users: Icon, Image: Icon, CheckCircle: Icon, Circle: Icon, Trash2: Icon, Combine: Icon };
});

const mockNavigate = { push: jest.fn(), canGoBack: jest.fn(() => true), goBack: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigate,
  useRoute: () => ({ params: { folderName: 'Faces', folderPath: 'Faces' } }),
}));

jest.mock('../../services/RemoteAlbumService', () => ({
  __esModule: true,
  default: {
    getRootCollection: jest.fn(),
    getCollectionByPath: jest.fn(),
    getAlbumsHierarchy: jest.fn().mockResolvedValue(null),
    deleteAlbums: jest.fn().mockResolvedValue(true),
    mergeAlbums: jest.fn().mockResolvedValue(true),
    deleteAlbumFromTree: jest.fn(),
  },
}));

import FolderDetailScreen from '../FolderDetailScreen';
import RemoteAlbumService from '../../services/RemoteAlbumService';

function buildFacesCollection(people) {
  const root = new LomoCollection('');
  const facesFolder = root.addCollection(new LomoCollection('Faces'));
  for (const p of people) {
    facesFolder.addAlbum(new LomoAlbum(p.name, { id: p.id, name: `/Faces/${p.name}`, coverImage: '', count: p.count }));
  }
  return root;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function findFaceCards(root) {
  // Face cards are the outer TouchableOpacity wrapping each person's card (has onLongPress).
  return root.findAll(node => node.type === TouchableOpacity && node.props.onLongPress);
}

describe('FolderDetailScreen - face album batch selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    Alert.alert.mockRestore();
  });

  test('long-pressing a person enters selection mode and selects it', async () => {
    RemoteAlbumService.getRootCollection.mockReturnValue(buildFacesCollection([
      { id: '1', name: 'alice', count: 5 },
      { id: '2', name: 'bob', count: 2 },
    ]));

    let component;
    await act(async () => { component = renderer.create(<FolderDetailScreen />); });
    await flush();

    const cards = findFaceCards(component.root);
    expect(cards.length).toBe(2);

    act(() => { cards[0].props.onLongPress(); });
    await flush();

    // Header should now show "1 Selected"
    const headerTexts = component.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(headerTexts.join(' ')).toContain('1 Selected');
  });

  test('tapping a second person while in selection mode adds it to the selection instead of navigating', async () => {
    RemoteAlbumService.getRootCollection.mockReturnValue(buildFacesCollection([
      { id: '1', name: 'alice', count: 5 },
      { id: '2', name: 'bob', count: 2 },
    ]));

    let component;
    await act(async () => { component = renderer.create(<FolderDetailScreen />); });
    await flush();

    let cards = findFaceCards(component.root);
    act(() => { cards[0].props.onLongPress(); });
    await flush();

    cards = findFaceCards(component.root);
    act(() => { cards[1].props.onPress(); });
    await flush();

    expect(mockNavigate.push).not.toHaveBeenCalled();
    const headerTexts = component.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(headerTexts.join(' ')).toContain('2 Selected');
  });

  test('deleting selected people calls RemoteAlbumService.deleteAlbums with their ids and exits selection mode', async () => {
    RemoteAlbumService.getRootCollection.mockReturnValue(buildFacesCollection([
      { id: '1', name: 'alice', count: 5 },
      { id: '2', name: 'bob', count: 2 },
    ]));

    let component;
    await act(async () => { component = renderer.create(<FolderDetailScreen />); });
    await flush();

    let cards = findFaceCards(component.root);
    act(() => { cards[0].props.onLongPress(); });
    await flush();

    // Capture the Alert.alert call for the delete confirmation and invoke its destructive button.
    const deleteButtons = component.root.findAll(
      n => n.type === TouchableOpacity && n.props.onPress && n.props.onPress.toString().includes('confirmBatchDelete')
    );
    expect(deleteButtons.length).toBeGreaterThan(0);

    act(() => { deleteButtons[0].props.onPress(); });
    expect(Alert.alert).toHaveBeenCalled();
    const alertArgs = Alert.alert.mock.calls[0];
    const destructiveButton = alertArgs[2].find(b => b.style === 'destructive');

    await act(async () => { await destructiveButton.onPress(); });
    await flush();

    expect(RemoteAlbumService.deleteAlbums).toHaveBeenCalledWith(['1']);
    expect(RemoteAlbumService.deleteAlbumFromTree).toHaveBeenCalledWith('1');

    const headerTexts = component.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(headerTexts.join(' ')).not.toContain('Selected');
  });

  test('merge is disabled with fewer than 2 selected, and merges into the higher-count name by default', async () => {
    RemoteAlbumService.getRootCollection.mockReturnValue(buildFacesCollection([
      { id: '1', name: 'alice', count: 5 },
      { id: '2', name: 'bob', count: 2 },
    ]));

    let component;
    await act(async () => { component = renderer.create(<FolderDetailScreen />); });
    await flush();

    let cards = findFaceCards(component.root);
    act(() => { cards[0].props.onLongPress(); }); // select alice (count 5)
    await flush();

    const mergeButtons = () => component.root.findAll(
      n => n.type === TouchableOpacity && n.props.onPress && n.props.onPress.toString().includes('openMergePrompt')
    );
    act(() => { mergeButtons()[0].props.onPress(); });
    await flush();
    // Still just 1 selected -- merge should be a no-op (no modal opened, no service call).
    expect(RemoteAlbumService.mergeAlbums).not.toHaveBeenCalled();

    cards = findFaceCards(component.root);
    act(() => { cards[1].props.onPress(); }); // add bob (count 2)
    await flush();

    act(() => { mergeButtons()[0].props.onPress(); });
    await flush();

    const nameInput = component.root.findByProps({ placeholder: 'Name' });
    expect(nameInput.props.value).toBe('alice'); // higher count wins as the default name

    const submitBtn = component.root.findAll(
      n => n.type === TouchableOpacity && n.props.onPress && n.props.onPress.toString().includes('handleMergeSubmit')
    )[0];

    await act(async () => { await submitBtn.props.onPress(); });
    await flush();

    expect(RemoteAlbumService.mergeAlbums).toHaveBeenCalledWith(['1', '2'], 'alice');
    expect(RemoteAlbumService.getAlbumsHierarchy).toHaveBeenCalled();
  });

  test('Cancel exits selection mode without calling any service methods', async () => {
    RemoteAlbumService.getRootCollection.mockReturnValue(buildFacesCollection([
      { id: '1', name: 'alice', count: 5 },
    ]));

    let component;
    await act(async () => { component = renderer.create(<FolderDetailScreen />); });
    await flush();

    const cards = findFaceCards(component.root);
    act(() => { cards[0].props.onLongPress(); });
    await flush();

    const cancelBtn = component.root.findAll(
      n => n.type === TouchableOpacity && n.props.onPress && n.props.onPress.toString().includes('cancelSelection')
    )[0];
    act(() => { cancelBtn.props.onPress(); });
    await flush();

    const headerTexts = component.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(headerTexts.join(' ')).not.toContain('Selected');
    expect(RemoteAlbumService.deleteAlbums).not.toHaveBeenCalled();
    expect(RemoteAlbumService.mergeAlbums).not.toHaveBeenCalled();
  });
});
