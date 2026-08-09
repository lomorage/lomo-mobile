import { isLivePhoto } from '../livePhoto';

describe('isLivePhoto', () => {
  test('is true when mediaSubtypes includes livePhoto', () => {
    expect(isLivePhoto({ mediaSubtypes: ['livePhoto'] })).toBe(true);
    expect(isLivePhoto({ mediaSubtypes: ['live'] })).toBe(true);
  });

  test('is true when the filename ends in .zip (Live Photo bundle)', () => {
    expect(isLivePhoto({ filename: 'IMG_1234.ZIP' })).toBe(true);
  });

  test('is true when the remote Merkle tree tag ends in .zip', () => {
    const remoteTree = { getNodeByHash: () => ({ tag: 'IMG_5678.zip' }) };
    expect(isLivePhoto({ hash: 'abc123' }, remoteTree)).toBe(true);
  });

  test('is false for a plain photo with no matching signal', () => {
    const remoteTree = { getNodeByHash: () => null };
    expect(isLivePhoto({ filename: 'IMG_9999.jpg', hash: 'abc123' }, remoteTree)).toBe(false);
  });

  test('does not throw when remoteTree is undefined and the asset only has a hash', () => {
    expect(() => isLivePhoto({ hash: 'abc123' }, undefined)).not.toThrow();
    expect(isLivePhoto({ hash: 'abc123' }, undefined)).toBe(false);
  });
});
