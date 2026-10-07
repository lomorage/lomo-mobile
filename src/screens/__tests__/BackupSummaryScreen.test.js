import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return { ShieldCheck: Icon, ChevronLeft: Icon };
});
jest.mock('../../services/AssetDBService', () => ({
  __esModule: true,
  default: { getFreeUpSpaceCandidates: jest.fn(), getBackupSummaryRows: jest.fn() },
}));
jest.mock('../../services/BackupSafetyService', () => ({
  __esModule: true,
  UNSAFE_REASONS: { SERVER_UNREACHABLE: 'server_unreachable', STORAGE_UNAVAILABLE: 'storage_unavailable', FILE_MISSING: 'file_missing' },
  default: { checkAll: jest.fn() },
}));
jest.mock('../../utils/scaleMetrics', () => ({ logSincePairedOnce: jest.fn() }));

const AssetDBService = require('../../services/AssetDBService').default;
const BackupSafetyService = require('../../services/BackupSafetyService').default;
const { logSincePairedOnce } = require('../../utils/scaleMetrics');
import BackupSummaryScreen from '../BackupSummaryScreen';

const navigation = { goBack: jest.fn(), replace: jest.fn() };
const allText = (tree) => tree.root.findAllByType(Text)
  .map(t => [].concat(t.props.children).filter(c => typeof c === 'string' || typeof c === 'number').join(''))
  .join('\n');
const pressText = (tree, label) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(b => b.findAllByType(Text).some(t => t.props.children === label));
  if (!button) throw new Error(`No button "${label}"`);
  return act(async () => { await button.props.onPress(); });
};

async function render() {
  let tree;
  await act(async () => { tree = renderer.create(<BackupSummaryScreen navigation={navigation} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return tree;
}

const summaryRows = (photo, video) => [
  { mediaType: 'photo', backedUpBytes: 0, unknownSize: 0, ...photo },
  { mediaType: 'video', backedUpBytes: 0, unknownSize: 0, ...video },
];

beforeEach(() => {
  jest.clearAllMocks();
  AssetDBService.getFreeUpSpaceCandidates.mockImplementation(async (type) => (type === 'video'
    ? [{ id: 'v1', mediaType: 'video', fileSize: 3000 }]
    : [{ id: 'p1', mediaType: 'photo', fileSize: 1000 }, { id: 'p2', mediaType: 'photo', fileSize: 1000 }]));
});

test('everything confirmed: says the photos are safe, logs Time to Safe, offers to free space', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 2, backedUp: 2, excluded: 0 }, { total: 1, backedUp: 1, excluded: 0 }));
  BackupSafetyService.checkAll.mockResolvedValue({ safe: ['p1', 'p2', 'v1'], unsafe: [], weakEvidence: false });
  const tree = await render();

  const text = allText(tree);
  expect(text).toContain('Your photos are safe at home');
  expect(text).toContain('2 photos and 1 video');
  expect(text).toContain('checked and safe on your Lomorage computer');
  expect(logSincePairedOnce).toHaveBeenCalledWith('time_to_safe', { photos: 2, videos: 1, bytes: 5000 });

  await pressText(tree, 'Free Up Space');
  expect(navigation.replace).toHaveBeenCalledWith('FreeUpSpace');
});

test('some not backed up, skipped or unconfirmed: says so and does not log Time to Safe', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 5, backedUp: 2, excluded: 1 }, { total: 1, backedUp: 1, excluded: 0 }));
  BackupSafetyService.checkAll.mockResolvedValue({ safe: ['p1', 'p2'], unsafe: [{ id: 'v1', reason: 'file_missing' }] });
  const tree = await render();

  const text = allText(tree);
  expect(text).toContain('Most of your photos are safe at home');
  expect(text).toContain('2 still to back up');
  expect(text).toContain("1 in albums you don't back up");
  expect(text).toContain("1 couldn't be confirmed");
  expect(logSincePairedOnce).not.toHaveBeenCalled();
});

test('computer unreachable: offers to try again, which re-checks', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 2, backedUp: 2 }, { total: 1, backedUp: 1 }));
  BackupSafetyService.checkAll.mockResolvedValue({
    safe: [], unsafe: ['p1', 'p2', 'v1'].map(id => ({ id, reason: 'server_unreachable' })),
  });
  const tree = await render();
  expect(allText(tree)).toContain("Couldn't reach your Lomorage computer");

  await pressText(tree, 'Try Again');
  expect(BackupSafetyService.checkAll).toHaveBeenCalledTimes(2);
});
