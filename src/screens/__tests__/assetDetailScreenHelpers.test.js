import { getCacheKey } from '../assetDetailScreenHelpers';

describe('getCacheKey', () => {
  test('uses the hash directly for a remote asset', () => {
    expect(getCacheKey({ status: 'remote', hash: 'abc123', id: 'ignored' })).toBe('abc123');
  });

  test('sanitizes non-alphanumeric characters out of the id for local/synced assets', () => {
    expect(getCacheKey({ status: 'local', id: 'ABCD-1234/EFGH_5678' })).toBe('ABCD1234EFGH5678');
  });

  test('returns an empty string when a local/synced asset has no id', () => {
    expect(getCacheKey({ status: 'synced', id: null })).toBe('');
    expect(getCacheKey({ status: 'local' })).toBe('');
  });
});
