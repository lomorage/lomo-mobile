import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text, TouchableOpacity } from 'react-native';

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props) => React.createElement(View, props) };
});
jest.mock('expo-video', () => ({ useVideoPlayer: jest.fn(), VideoView: () => null }));
jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { ScrollView } = require('react-native');
  return {
    FlashList: ({ data, renderItem }) => React.createElement(
      ScrollView, {}, (data || []).map((item, index) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index })))
    ),
  };
});
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { ChevronLeft: Icon, Trash2: Icon, CheckCircle2: Icon, Circle: Icon, X: Icon };
});
jest.mock('../../hooks/useServerEpoch', () => ({ useServerEpoch: () => 0 }));
jest.mock('../../hooks/useImageRetry', () => ({
  useImageRetry: () => ({ retryTick: 0, onError: jest.fn() }),
  withRetryBuster: (uri) => uri,
}));
jest.mock('../../services/AssetDBService', () => ({
  __esModule: true,
  default: {
    getFreeUpSpaceCandidates: jest.fn(),
    getBackupSummaryRows: jest.fn(),
    setAssetFileSizes: jest.fn(() => Promise.resolve()),
    markAssetsRemovedLocally: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('../../services/MediaService', () => ({
  __esModule: true,
  default: {
    getAssetSize: jest.fn(),
    deleteLocalAssets: jest.fn(() => Promise.resolve(true)),
    getAssetInfo: jest.fn(),
    getPreviewUrl: jest.fn(() => 'http://server/preview'),
  },
}));
jest.mock('../../services/BackupSafetyService', () => ({
  __esModule: true,
  UNSAFE_REASONS: { FILE_MISSING: 'file_missing', SERVER_UNREACHABLE: 'server_unreachable' },
  default: { checkAll: jest.fn() },
}));

const AssetDBService = require('../../services/AssetDBService').default;
const MediaService = require('../../services/MediaService').default;
const BackupSafetyService = require('../../services/BackupSafetyService').default;
import FreeUpSpaceScreen from '../FreeUpSpaceScreen';

const videos = [
  { id: 'v1', hash: 'h-v1', mediaType: 'video', createTime: 1, fileSize: 5000 },
  { id: 'v2', hash: 'h-v2', mediaType: 'video', createTime: 2, fileSize: null },
];
const photos = [{ id: 'p1', hash: 'h-p1', mediaType: 'photo', createTime: 3, fileSize: 100 }];
const navigation = { goBack: jest.fn(), navigate: jest.fn() };

const allText = (tree) => tree.root.findAllByType(Text)
  .map(t => [].concat(t.props.children).filter(c => typeof c === 'string' || typeof c === 'number').join(''))
  .join('\n');
const pressText = (tree, label) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(b => b.findAllByType(Text).some(t => t.props.children === label));
  if (!button) throw new Error(`No button "${label}"`);
  return act(async () => { await button.props.onPress(); });
};
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

async function render() {
  let tree;
  await act(async () => { tree = renderer.create(<FreeUpSpaceScreen navigation={navigation} />); });
  await flush();
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  AssetDBService.getFreeUpSpaceCandidates.mockImplementation(async (type) => (type === 'video' ? videos : photos));
  AssetDBService.getBackupSummaryRows.mockResolvedValue([
    { mediaType: 'video', total: 2, backedUp: 2, backedUpBytes: 5000, unknownSize: 1, excluded: 0 },
    { mediaType: 'photo', total: 4, backedUp: 1, backedUpBytes: 100, unknownSize: 0, excluded: 1 },
  ]);
  MediaService.getAssetSize.mockResolvedValue(7000);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

test('shows what is backed up, what can be freed, and what stays', async () => {
  const tree = await render();
  const text = allText(tree);
  expect(text).toContain('1 photo and 2 videos on this phone are backed up');
  expect(text).toMatch(/can be freed/);
  expect(text).toContain('2 not backed up yet');
  expect(text).toContain("1 in albums you don't back up");
  expect(text).toContain('Videos (2)');
  expect(text).toContain('Photos (1)');
});

test('measures and remembers sizes the DB does not have yet', async () => {
  await render();
  expect(MediaService.getAssetSize).toHaveBeenCalledWith('v2');
  expect(MediaService.getAssetSize).not.toHaveBeenCalledWith('v1');
  expect(AssetDBService.setAssetFileSizes).toHaveBeenCalledWith([{ id: 'v2', size: 7000 }]);
});

test('deletes only what the computer confirmed, after the user confirms', async () => {
  BackupSafetyService.checkAll.mockResolvedValue({
    safe: ['v1'], unsafe: [{ id: 'v2', reason: 'file_missing' }], weakEvidence: false,
  });
  const tree = await render();
  await pressText(tree, 'Select All');
  await pressText(tree, 'Delete');

  expect(BackupSafetyService.checkAll).toHaveBeenCalledWith(expect.arrayContaining(['v1', 'v2']), expect.any(Function));
  const [title, message, buttons] = Alert.alert.mock.calls[0];
  expect(title).toBe('Delete from Device');
  expect(message).toContain('1 video is confirmed safe');
  expect(message).toContain('1 will stay on this phone');
  expect(MediaService.deleteLocalAssets).not.toHaveBeenCalled();

  await act(async () => { await buttons.find(b => b.text === 'Delete').onPress(); });
  expect(MediaService.deleteLocalAssets).toHaveBeenCalledWith(['v1']);
  expect(AssetDBService.markAssetsRemovedLocally).toHaveBeenCalledWith(['v1']);
  expect(allText(tree)).toContain('Videos (1)');
});

test('nothing is deleted when nothing could be confirmed', async () => {
  BackupSafetyService.checkAll.mockResolvedValue({
    safe: [], unsafe: [{ id: 'v1', reason: 'server_unreachable' }, { id: 'v2', reason: 'server_unreachable' }],
  });
  const tree = await render();
  await pressText(tree, 'Select All');
  await pressText(tree, 'Delete');

  expect(Alert.alert.mock.calls[0][0]).toBe('Not Safe to Delete Yet');
  expect(MediaService.deleteLocalAssets).not.toHaveBeenCalled();
});
