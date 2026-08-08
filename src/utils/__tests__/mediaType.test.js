import { isVideoExtension } from '../mediaType';

describe('isVideoExtension', () => {
  test('returns false for falsy/empty filenames', () => {
    expect(isVideoExtension(null)).toBe(false);
    expect(isVideoExtension(undefined)).toBe(false);
    expect(isVideoExtension('')).toBe(false);
  });

  test('recognizes all supported video extensions', () => {
    expect(isVideoExtension('IMG_1234.mp4')).toBe(true);
    expect(isVideoExtension('IMG_1234.mov')).toBe(true);
    expect(isVideoExtension('IMG_1234.avi')).toBe(true);
    expect(isVideoExtension('IMG_1234.mkv')).toBe(true);
    expect(isVideoExtension('IMG_1234.webm')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isVideoExtension('IMG_1234.MOV')).toBe(true);
    expect(isVideoExtension('IMG_1234.Mp4')).toBe(true);
  });

  test('returns false for photo/other extensions', () => {
    expect(isVideoExtension('IMG_1234.jpg')).toBe(false);
    expect(isVideoExtension('IMG_1234.png')).toBe(false);
    expect(isVideoExtension('document.pdf')).toBe(false);
  });

  test('returns false for a filename with no extension', () => {
    expect(isVideoExtension('IMG_1234')).toBe(false);
  });

  test('uses the last extension for filenames with multiple dots', () => {
    expect(isVideoExtension('archive.tar.mp4')).toBe(true);
    expect(isVideoExtension('archive.mp4.zip')).toBe(false);
  });
});
