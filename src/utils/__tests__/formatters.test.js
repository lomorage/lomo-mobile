import { formatBytes, formatSpeed } from '../formatters';

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
