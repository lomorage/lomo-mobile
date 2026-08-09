import { parseBackendDate } from '../backendDate';

describe('parseBackendDate', () => {
  test('returns null for falsy input', () => {
    expect(parseBackendDate(null)).toBeNull();
    expect(parseBackendDate(undefined)).toBeNull();
    expect(parseBackendDate('')).toBeNull();
  });

  test('returns a Date instance unchanged (identity)', () => {
    const d = new Date('2024-03-16T08:23:26Z');
    expect(parseBackendDate(d)).toBe(d);
  });

  test('treats a naive "YYYY-MM-DD HH:mm:ss" string as UTC, not local time', () => {
    const result = parseBackendDate('2024-03-16 08:23:26');
    expect(result.toISOString()).toBe('2024-03-16T08:23:26.000Z');
  });

  test('leaves an already-UTC ("Z" suffixed) string alone', () => {
    const result = parseBackendDate('2024-03-16T08:23:26Z');
    expect(result.toISOString()).toBe('2024-03-16T08:23:26.000Z');
  });

  test('respects an explicit +HH:MM offset instead of forcing UTC', () => {
    const result = parseBackendDate('2024-03-16T08:23:26+08:00');
    // 08:23:26 at UTC+8 is 00:23:26 UTC
    expect(result.toISOString()).toBe('2024-03-16T00:23:26.000Z');
  });

  test('respects a -HHMM offset with no colon', () => {
    const result = parseBackendDate('2024-03-16T08:23:26-0500');
    // 08:23:26 at UTC-5 is 13:23:26 UTC
    expect(result.toISOString()).toBe('2024-03-16T13:23:26.000Z');
  });

  test('returns null for an unparseable string', () => {
    expect(parseBackendDate('not a date')).toBeNull();
  });

  test('treats a naive T-separated string (no timezone) as UTC too', () => {
    const result = parseBackendDate('2024-03-16T08:23:26');
    expect(result.toISOString()).toBe('2024-03-16T08:23:26.000Z');
  });

  test('a date-only string is parsed as UTC midnight (ISO 8601 date-only default)', () => {
    // Note: the day-of-month digits can coincidentally look like a timezone
    // offset to the regex (e.g. the "-16" in "2024-03-16"), but this still
    // resolves correctly because JS treats bare YYYY-MM-DD as UTC per spec.
    const result = parseBackendDate('2024-03-16');
    expect(result.toISOString()).toBe('2024-03-16T00:00:00.000Z');
  });
});
