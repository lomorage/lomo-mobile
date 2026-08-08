import { parseTimeTokenExtra, isLivePhoto } from '../homeScreenHelpers';

const startOfDay = (d) => {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd.getTime();
};
const endOfDay = (d) => {
  const nd = new Date(d);
  nd.setHours(23, 59, 59, 999);
  return nd.getTime();
};

describe('parseTimeTokenExtra', () => {
  test('returns null for unrecognized tokens', () => {
    expect(parseTimeTokenExtra('dogs')).toBeNull();
    expect(parseTimeTokenExtra('')).toBeNull();
  });

  test('parses a bare 4-digit year', () => {
    const result = parseTimeTokenExtra('2019');
    expect(result.startTime).toBe(new Date(2019, 0, 1, 0, 0, 0, 0).getTime());
    expect(result.endTime).toBe(new Date(2019, 11, 31, 23, 59, 59, 999).getTime());
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(parseTimeTokenExtra('  Yesterday  ')).not.toBeNull();
  });

  describe('with a fixed "now" (Wednesday 2026-06-17)', () => {
    const NOW = new Date(2026, 5, 17, 15, 0, 0);

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test('"yesterday" resolves to the full previous day', () => {
      const yesterday = new Date(2026, 5, 16);
      const result = parseTimeTokenExtra('yesterday');
      expect(result.startTime).toBe(startOfDay(yesterday));
      expect(result.endTime).toBe(endOfDay(yesterday));
    });

    test('"last week" resolves to the previous Sun-Sat calendar week', () => {
      // now (Wed) - 7 - getDay()(3) = 10 days back -> Sun 2026-06-07
      const result = parseTimeTokenExtra('last week');
      const expectedStart = new Date(2026, 5, 7);
      const expectedEnd = new Date(2026, 5, 13);
      expect(result.startTime).toBe(startOfDay(expectedStart));
      expect(result.endTime).toBe(endOfDay(expectedEnd));
    });

    test('"last month" spans the entirety of the previous calendar month', () => {
      const result = parseTimeTokenExtra('last month');
      expect(result.startTime).toBe(new Date(2026, 4, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2026, 4, 31, 23, 59, 59, 999).getTime());
    });

    test('"last year" spans the entirety of the previous calendar year', () => {
      const result = parseTimeTokenExtra('last year');
      expect(result.startTime).toBe(new Date(2025, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2025, 11, 31, 23, 59, 59, 999).getTime());
    });

    test('"this year" spans from Jan 1st through end of today', () => {
      const result = parseTimeTokenExtra('this year');
      expect(result.startTime).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(endOfDay(NOW));
    });
  });
});

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
