jest.mock('../../services/BackupSafetyService', () => ({
  UNSAFE_REASONS: {
    NOT_BACKED_UP: 'not_backed_up',
    MODIFIED_SINCE_BACKUP: 'modified_since_backup',
    MISSING_LOCALLY: 'missing_locally',
    MISSING_ON_SERVER: 'missing_on_server',
    FILE_MISSING: 'file_missing',
    LINKED_ONLY: 'linked_only',
    DAMAGED: 'damaged',
    STORAGE_UNAVAILABLE: 'storage_unavailable',
    SERVER_UNREACHABLE: 'server_unreachable',
    UNCONFIRMED: 'unconfirmed',
  },
}));

import { buildDeleteConfirmation, isVerificationStale, VERIFY_MAX_AGE_MS } from '../freeUpSpaceHelpers';

const formatSize = (bytes) => `${bytes}B`;
const items = [
  { id: 'a', sizeBytes: 100, mediaType: 'video' },
  { id: 'b', sizeBytes: 50, mediaType: 'video' },
  { id: 'c', sizeBytes: 7, mediaType: 'photo' },
];

test('all safe: only safe items are deletable and size counts only them', () => {
  const { message, deletable } = buildDeleteConfirmation({ safe: ['a', 'b'], unsafe: [], weakEvidence: false }, items, formatSize);
  expect(deletable).toEqual(['a', 'b']);
  expect(message).toContain('2 videos are confirmed safe on your Lomorage computer');
  expect(message).toContain('150B');
  expect(message).not.toContain('stay on this phone');
  expect(message).not.toContain('older version');
});

test('photos and videos are counted separately', () => {
  const { message } = buildDeleteConfirmation({ safe: ['a', 'c'], unsafe: [] }, items, formatSize);
  expect(message).toContain('1 photo and 1 video are confirmed safe');
  expect(message).toContain('107B');
});

test('mixed: explains what stays on the phone, grouped by reason', () => {
  const { message, deletable } = buildDeleteConfirmation({
    safe: ['a'],
    unsafe: [{ id: 'b', reason: 'linked_only' }, { id: 'c', reason: 'linked_only' }],
  }, items, formatSize);
  expect(deletable).toEqual(['a']);
  expect(message).toContain('1 video is confirmed safe');
  expect(message).toContain('100B');
  expect(message).toContain('2 will stay on this phone');
  expect(message).toContain('• 2 only in a folder on your computer, not in your Lomorage library');
});

test('nothing safe: nothing deletable', () => {
  const { message, deletable } = buildDeleteConfirmation({
    safe: [], unsafe: [{ id: 'a', reason: 'storage_unavailable' }],
  }, items, formatSize);
  expect(deletable).toEqual([]);
  expect(message).not.toContain('confirmed safe');
  expect(message).toContain("drive with your photos isn't available");
});

test('older server: does not claim the files were confirmed and suggests updating', () => {
  const { message, deletable } = buildDeleteConfirmation({ safe: ['a'], unsafe: [], weakEvidence: true }, items, formatSize);
  expect(deletable).toEqual(['a']);
  expect(message).not.toContain('confirmed safe');
  expect(message).toContain('backed up to your Lomorage computer');
  expect(message).toContain('older version');
});

test('every reason has user-facing text without technical jargon', () => {
  const reasons = ['not_backed_up', 'modified_since_backup', 'missing_locally', 'missing_on_server',
    'file_missing', 'linked_only', 'damaged', 'storage_unavailable', 'server_unreachable', 'unconfirmed'];
  for (const reason of reasons) {
    const { message } = buildDeleteConfirmation({ safe: [], unsafe: [{ id: 'a', reason }] }, items, formatSize);
    expect(message).not.toContain(reason);
    expect(message).not.toMatch(/server|NAS|hash|HEAD/i);
  }
});

test('a file missing from the computer is not promised a re-upload', () => {
  const { message } = buildDeleteConfirmation({ safe: [], unsafe: [{ id: 'a', reason: 'file_missing' }] }, items, formatSize);
  expect(message).toContain('missing from your Lomorage computer');
  expect(message).not.toMatch(/backed up again/);
});

test('verification goes stale after the max age', () => {
  expect(isVerificationStale(0, VERIFY_MAX_AGE_MS)).toBe(false);
  expect(isVerificationStale(0, VERIFY_MAX_AGE_MS + 1)).toBe(true);
});
