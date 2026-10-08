import { exifTakenTime, parseExifDateTime, resolveTakenTime } from '../takenTime';

test('parses EXIF date-times as local wall-clock time', () => {
  expect(parseExifDateTime('2019:03:04 12:27:32')).toBe(new Date(2019, 2, 4, 12, 27, 32).getTime());
  expect(parseExifDateTime('2019-03-04T12:27:32')).toBe(new Date(2019, 2, 4, 12, 27, 32).getTime());
  expect(parseExifDateTime('0000:00:00 00:00:00')).toBeNull();
  expect(parseExifDateTime('')).toBeNull();
  expect(parseExifDateTime(undefined)).toBeNull();
});

test('finds the taken time in Android (flat) and iOS ({Exif}) exif objects, preferring DateTimeOriginal', () => {
  const original = new Date(2019, 2, 4, 12, 27, 32).getTime();
  expect(exifTakenTime({ DateTime: '2020:01:01 00:00:00', DateTimeOriginal: '2019:03:04 12:27:32' })).toBe(original);
  expect(exifTakenTime({ '{Exif}': { DateTimeOriginal: '2019:03:04 12:27:32' } })).toBe(original);
  expect(exifTakenTime({ DateTimeDigitized: '2019:03:04 12:27:32' })).toBe(original);
  expect(exifTakenTime({})).toBeNull();
  expect(exifTakenTime(null)).toBeNull();
});

test('resolves: OS taken date, else EXIF, else file time', () => {
  const exif = { DateTimeOriginal: '2019:03:04 12:27:32' };
  expect(resolveTakenTime({ creationTime: 5, modificationTime: 9, exif })).toBe(5);
  expect(resolveTakenTime({ creationTime: 0, modificationTime: 9, exif })).toBe(new Date(2019, 2, 4, 12, 27, 32).getTime());
  expect(resolveTakenTime({ creationTime: 0, modificationTime: 9 }, 7)).toBe(7);
  expect(resolveTakenTime({ creationTime: 0, modificationTime: 9 })).toBe(9);
  expect(resolveTakenTime({ creationTime: 0, modificationTime: 0 })).toBeNull();
});
