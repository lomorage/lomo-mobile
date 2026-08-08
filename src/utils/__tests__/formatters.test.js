import { formatBytes, formatSpeed, formatBytesLog } from '../formatters';

describe('formatBytes', () => {
  test('returns empty string for falsy/zero/negative input', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-5)).toBe('');
  });

  test('formats sub-KB sizes as whole bytes', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('formats KB range with one decimal place', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  test('formats MB range with one decimal place', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatSpeed', () => {
  test('returns empty string for falsy/zero/negative input', () => {
    expect(formatSpeed(0)).toBe('');
    expect(formatSpeed(null)).toBe('');
    expect(formatSpeed(-1)).toBe('');
  });

  test('formats sub-KB/s speeds as whole bytes/s', () => {
    expect(formatSpeed(500)).toBe('500 B/s');
  });

  test('formats KB/s and MB/s ranges', () => {
    expect(formatSpeed(2048)).toBe('2.0 KB/s');
    expect(formatSpeed(3 * 1024 * 1024)).toBe('3.0 MB/s');
  });
});

describe('formatBytesLog', () => {
  test('defaults to "0 B" fallback and 2 decimal places', () => {
    expect(formatBytesLog(0)).toBe('0 B');
    expect(formatBytesLog(null)).toBe('0 B');
    expect(formatBytesLog(1536)).toBe('1.5 KB');
  });

  test('supports a custom fallback string (DuplicatesScreen AssetCard uses "")', () => {
    expect(formatBytesLog(0, { fallback: '' })).toBe('');
  });

  test('supports a custom fallback string (DuplicatesScreen modal uses "Unknown")', () => {
    expect(formatBytesLog(0, { fallback: 'Unknown' })).toBe('Unknown');
  });

  test('supports 1-decimal precision (FreeUpSpaceScreen)', () => {
    expect(formatBytesLog(1536, { decimals: 1 })).toBe('1.5 KB');
    expect(formatBytesLog(1234, { decimals: 1 })).toBe('1.2 KB');
  });

  test('scales up through B/KB/MB/GB tiers', () => {
    expect(formatBytesLog(500)).toBe('500 B');
    expect(formatBytesLog(1024 * 1024)).toBe('1 MB');
    expect(formatBytesLog(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});
