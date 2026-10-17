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
  default: { getFreeUpSpaceCandidates: jest.fn(), getBackupSummaryRows: jest.fn(), getAtHomeCounts: jest.fn() },
}));
jest.mock('../../services/BackupSafetyService', () => ({
  __esModule: true,
  UNSAFE_REASONS: { SERVER_UNREACHABLE: 'server_unreachable', STORAGE_UNAVAILABLE: 'storage_unavailable', FILE_MISSING: 'file_missing' },
  default: {
    checkAll: jest.fn(),
    // records the screen's listener so a test can play "a lost file was put back"
    onRestored: jest.fn((listener) => {
      mockRestoredListeners.add(listener);
      return () => mockRestoredListeners.delete(listener);
    }),
  },
}));
const mockRestoredListeners = new Set();
jest.mock('../../services/SyncService', () => ({ __esModule: true, default: { fetchRemoteOverview: jest.fn() } }));
jest.mock('../../utils/scaleMetrics', () => ({ logSincePairedOnce: jest.fn() }));
jest.mock('../../services/AuthService', () => ({ __esModule: true, default: { getServerName: jest.fn(() => 'windows') } }));
jest.mock('../../services/backupHistory', () => ({ getLastBackupAt: jest.fn(async () => Date.now() - 60 * 1000) }));

const AssetDBService = require('../../services/AssetDBService').default;
const BackupSafetyService = require('../../services/BackupSafetyService').default;
const SyncService = require('../../services/SyncService').default;
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
  mockRestoredListeners.clear(); // earlier tests' screens stay mounted
  AssetDBService.getAtHomeCounts.mockResolvedValue({ photos: 0, videos: 0 });
  SyncService.fetchRemoteOverview.mockResolvedValue({});
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
  expect(text).toContain('checked and safe on your computer “windows”');
  expect(text).toMatch(/Last backup: today at /);
  expect(logSincePairedOnce).toHaveBeenCalledWith('time_to_safe', { photos: 2, videos: 1, bytes: 5000 });

  await pressText(tree, 'Free Up Space');
  expect(navigation.replace).toHaveBeenCalledWith('FreeUpSpace');
});

test('some not backed up, skipped or unconfirmed: says so and does not log Time to Safe', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 5, backedUp: 2, excluded: 1 }, { total: 1, backedUp: 1, excluded: 0 }));
  BackupSafetyService.checkAll.mockResolvedValue({
    safe: ['p1'], unsafe: [{ id: 'v1', reason: 'file_missing' }, { id: 'p2', reason: 'damaged' }],
  });
  const tree = await render();

  const text = allText(tree);
  expect(text).toContain('Most of your photos are safe at home');
  expect(text).toContain('2 still to back up');
  expect(text).toContain("1 in albums you don't back up");
  expect(text).toContain('1 is missing from your Lomorage computer — it stays on this phone.');
  expect(text).toContain("1 couldn't be confirmed");
  expect(logSincePairedOnce).not.toHaveBeenCalled();
});

describe('after freeing space, when nothing is left on the phone to check', () => {
  // The rows left behind say the computer holds them. Only the computer can say it still does,
  // and the backup's Merkle sync is what asks: it drops the rows the computer no longer lists.
  const computerHolds = ({ photos = 0, videos = 0, lost = 0 }) => {
    AssetDBService.getAtHomeCounts
      .mockResolvedValueOnce({ photos: photos + lost, videos }) // the mirror, before the refresh
      .mockResolvedValue({ photos, videos }); // what the computer listed just now
  };

  beforeEach(() => {
    AssetDBService.getFreeUpSpaceCandidates.mockResolvedValue([]);
    BackupSafetyService.checkAll.mockResolvedValue({ safe: [], unsafe: [], weakEvidence: false });
  });

  test('asks the computer once, then says the photos are safe at home', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue([]); // no local rows any more
    computerHolds({ photos: 100, videos: 2 });
    const tree = await render();

    const text = allText(tree);
    expect(SyncService.fetchRemoteOverview).toHaveBeenCalledTimes(1);
    expect(text).toContain('Your photos are safe at home');
    expect(text).toContain('100 photos and 2 videos');
    expect(text).toContain('on your computer “windows”');
    expect(text).toContain('Nothing left on this phone to free up');
    expect(text).not.toContain('Nothing is backed up yet');
    expect(() => allText(tree) && pressText(tree, 'Free Up Space')).toThrow('No button "Free Up Space"');
  });

  test('the computer cannot be reached: says so instead of calling the photos safe', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue([]);
    AssetDBService.getAtHomeCounts.mockResolvedValue({ photos: 100, videos: 2 });
    const offline = new Error('Could not reach server. Check your connection and try again.');
    offline.isNetworkError = true;
    SyncService.fetchRemoteOverview.mockRejectedValue(offline);
    const tree = await render();

    const text = allText(tree);
    expect(text).toContain("Couldn't reach your Lomorage computer");
    expect(text).not.toContain('safe at home');
    expect(text).not.toContain('100 photos');
  });

  test('photos the computer no longer lists are counted as gone, not as safe', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue([]);
    computerHolds({ photos: 98, videos: 0, lost: 2 });
    const tree = await render();

    const text = allText(tree);
    expect(text).toContain('98 photos');
    expect(text).not.toContain('100 photos');
    expect(text).toContain('2 freed from this phone are no longer on your Lomorage computer');
    expect(text).toContain('Most of your photos are safe at home');
    expect(text).not.toContain('Your photos are safe at home');
  });

  test('the computer has lost everything this phone freed: says they are missing', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue([]);
    computerHolds({ photos: 0, videos: 0, lost: 100 });
    const tree = await render();

    const text = allText(tree);
    expect(text).toContain('Your photos are missing from your computer');
    expect(text).toContain('100 freed from this phone are no longer on your Lomorage computer');
    expect(text).not.toContain('safe at home');
    expect(text).not.toContain('Nothing is backed up yet');
  });

  test('items still to back up are mentioned, and the title is softened', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 3, backedUp: 0, excluded: 0 }, { total: 0, backedUp: 0 }));
    computerHolds({ photos: 100, videos: 2 });
    const tree = await render();

    const text = allText(tree);
    expect(text).toContain('Most of your photos are safe at home');
    expect(text).toContain('3 still to back up');
    expect(text).not.toContain('Nothing is backed up yet');
  });

  test('a phone that has genuinely backed up nothing yet still says so', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 5, backedUp: 0, excluded: 0 }, { total: 0, backedUp: 0 }));
    AssetDBService.getAtHomeCounts.mockResolvedValue({ photos: 0, videos: 0 });
    const tree = await render();

    expect(allText(tree)).toContain('Nothing is backed up yet');
  });

  test('does not log Time to Safe (that is for the first backup)', async () => {
    AssetDBService.getBackupSummaryRows.mockResolvedValue([]);
    computerHolds({ photos: 4, videos: 0 });
    await render();
    expect(logSincePairedOnce).not.toHaveBeenCalled();
  });
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

test('a lost file put back on the computer: says so, checks again, and stops listening once closed', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 2, backedUp: 2 }, { total: 1, backedUp: 1 }));
  BackupSafetyService.checkAll.mockResolvedValueOnce({ safe: ['p1', 'p2'], unsafe: [{ id: 'v1', reason: 'file_missing_restoring' }] });
  BackupSafetyService.checkAll.mockResolvedValue({ safe: ['p1', 'p2', 'v1'], unsafe: [], weakEvidence: false });
  const tree = await render();
  expect(BackupSafetyService.checkAll).toHaveBeenCalledTimes(1);
  expect(allText(tree)).toContain("Restoring 1 to your computer — it had lost it. It stays on this phone until that's done.");
  expect(allText(tree)).not.toContain("couldn't be confirmed");

  await act(async () => { mockRestoredListeners.forEach(listener => listener()); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  expect(BackupSafetyService.checkAll).toHaveBeenCalledTimes(2);

  await act(async () => { tree.unmount(); });
  expect(mockRestoredListeners.size).toBe(0);
});

test('several lost files: restoring and missing counted apart, in plural', async () => {
  AssetDBService.getBackupSummaryRows.mockResolvedValue(summaryRows({ total: 2, backedUp: 2 }, { total: 1, backedUp: 1 }));
  BackupSafetyService.checkAll.mockResolvedValue({
    safe: [],
    unsafe: [
      { id: 'p1', reason: 'file_missing_restoring' },
      { id: 'p2', reason: 'file_missing_restoring' },
      { id: 'v1', reason: 'file_missing' },
    ],
  });
  const tree = await render();
  const text = allText(tree);
  expect(text).toContain("Restoring 2 to your computer — it had lost them. They stay on this phone until that's done.");
  expect(text).toContain('1 is missing from your Lomorage computer — it stays on this phone.');
  expect(text).not.toContain("couldn't be confirmed");
});
