import { extractTimeRange } from '../searchQueryParser';

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

describe('extractTimeRange', () => {
  test('returns nulls and empty remainingText for empty/undefined input', () => {
    expect(extractTimeRange('')).toEqual({ startTime: null, endTime: null, remainingText: '' });
    expect(extractTimeRange(undefined)).toEqual({ startTime: null, endTime: null, remainingText: '' });
  });

  test('returns nulls and the original (trimmed) text when no date is mentioned', () => {
    expect(extractTimeRange('  dog on the beach  ')).toEqual({
      startTime: null,
      endTime: null,
      remainingText: 'dog on the beach',
    });
  });

  describe('relative date terms (fixed "now")', () => {
    // A Monday, so "last week" has an unambiguous 7-day-back anchor.
    const NOW = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 12:00 local time

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test('"today" resolves to the full current day and strips the word', () => {
      const result = extractTimeRange('cat today');
      expect(result.startTime).toBe(startOfDay(NOW));
      expect(result.endTime).toBe(endOfDay(NOW));
      expect(result.remainingText).toBe('cat');
    });

    test('中文 "今天" behaves the same as "today"', () => {
      const result = extractTimeRange('猫 今天');
      expect(result.startTime).toBe(startOfDay(NOW));
      expect(result.endTime).toBe(endOfDay(NOW));
    });

    test('"yesterday" resolves to the full previous day', () => {
      const yesterday = new Date(2026, 5, 14);
      const result = extractTimeRange('yesterday');
      expect(result.startTime).toBe(startOfDay(yesterday));
      expect(result.endTime).toBe(endOfDay(yesterday));
    });

    test('"last week" spans from 7 days ago through the end of today', () => {
      const lastWeek = new Date(2026, 5, 8);
      const result = extractTimeRange('last week');
      expect(result.startTime).toBe(startOfDay(lastWeek));
      expect(result.endTime).toBe(endOfDay(NOW));
    });

    test('"last month" spans the entirety of the previous calendar month', () => {
      const result = extractTimeRange('last month');
      expect(result.startTime).toBe(new Date(2026, 4, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2026, 4, 31, 23, 59, 59, 999).getTime());
    });

    test('"last year" spans the entirety of the previous calendar year', () => {
      const result = extractTimeRange('last year');
      expect(result.startTime).toBe(new Date(2025, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2025, 11, 31, 23, 59, 59, 999).getTime());
    });

    test('"this month" spans from the 1st of this month through end of today', () => {
      const result = extractTimeRange('this month');
      expect(result.startTime).toBe(new Date(2026, 5, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(endOfDay(NOW));
    });

    test('"this year" spans from Jan 1st through end of today', () => {
      const result = extractTimeRange('this year');
      expect(result.startTime).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(endOfDay(NOW));
    });
  });

  describe('absolute dates (no fake timers needed)', () => {
    test('YYYY-MM-DD resolves to that single day', () => {
      const result = extractTimeRange('sunset 2024-03-05');
      const day = new Date(2024, 2, 5);
      expect(result.startTime).toBe(startOfDay(day));
      expect(result.endTime).toBe(endOfDay(day));
      expect(result.remainingText).toBe('sunset');
    });

    test('YYYY/MM/DD and YYYY.MM.DD are also accepted', () => {
      const day = new Date(2024, 2, 5);
      expect(extractTimeRange('2024/03/05').startTime).toBe(startOfDay(day));
      expect(extractTimeRange('2024.03.05').startTime).toBe(startOfDay(day));
    });

    test('Chinese YYYY年MM月DD日 resolves to that single day', () => {
      const result = extractTimeRange('2024年3月5日 的照片');
      const day = new Date(2024, 2, 5);
      expect(result.startTime).toBe(startOfDay(day));
      expect(result.endTime).toBe(endOfDay(day));
    });

    test('8-digit YYYYMMDD resolves to that single day', () => {
      const result = extractTimeRange('20240305');
      const day = new Date(2024, 2, 5);
      expect(result.startTime).toBe(startOfDay(day));
      expect(result.endTime).toBe(endOfDay(day));
    });

    test('YYYY-MM resolves to the full calendar month', () => {
      const result = extractTimeRange('2024-03');
      expect(result.startTime).toBe(new Date(2024, 2, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2024, 2, 31, 23, 59, 59, 999).getTime());
    });

    test('Chinese YYYY年MM月 resolves to the full calendar month', () => {
      const result = extractTimeRange('2024年3月');
      expect(result.startTime).toBe(new Date(2024, 2, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2024, 2, 31, 23, 59, 59, 999).getTime());
    });

    test('Chinese YYYY年 resolves to the full calendar year', () => {
      const result = extractTimeRange('2024年');
      expect(result.startTime).toBe(new Date(2024, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2024, 11, 31, 23, 59, 59, 999).getTime());
    });

    test('a bare 4-digit year in a plausible range resolves to the full calendar year', () => {
      const result = extractTimeRange('vacation 2019');
      expect(result.startTime).toBe(new Date(2019, 0, 1, 0, 0, 0, 0).getTime());
      expect(result.endTime).toBe(new Date(2019, 11, 31, 23, 59, 59, 999).getTime());
      expect(result.remainingText).toBe('vacation');
    });

    test('a 4-digit number outside the plausible year range (1990-2100) is left untouched', () => {
      const result = extractTimeRange('receipt #1080');
      expect(result.startTime).toBeNull();
      expect(result.endTime).toBeNull();
      expect(result.remainingText).toBe('receipt #1080');
    });
  });
});
