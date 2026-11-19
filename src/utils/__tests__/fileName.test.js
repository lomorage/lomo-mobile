import { displayFileName, downloadFileName, nameFromContentDisposition, safeFileName } from '../fileName';

describe('displayFileName', () => {
  test('prefers the name from the phone over the server name', () => {
    expect(displayFileName({ filename: '20240101000012.heic', originalName: 'IMG_1234.HEIC' })).toBe('IMG_1234.HEIC');
  });
  test('falls back to the server name, then nothing', () => {
    expect(displayFileName({ filename: '20240101000012.heic', originalName: null })).toBe('20240101000012.heic');
    expect(displayFileName({})).toBe('');
    expect(displayFileName(undefined)).toBe('');
  });
});

describe('nameFromContentDisposition', () => {
  test('reads the UTF-8 name lomod sends', () => {
    expect(nameFromContentDisposition(`inline; filename="_t_.jpg"; filename*=UTF-8''%C3%A9t%C3%A9.jpg`)).toBe('été.jpg');
  });
  test('falls back to the plain name', () => {
    expect(nameFromContentDisposition('attachment; filename="IMG_1.jpg"')).toBe('IMG_1.jpg');
    expect(nameFromContentDisposition('attachment; filename=IMG_1.jpg')).toBe('IMG_1.jpg');
    expect(nameFromContentDisposition(`inline; filename="a.jpg"; filename*=UTF-8''%E0%A4%A.jpg`)).toBe('a.jpg');
  });
  test('nothing without a name', () => {
    expect(nameFromContentDisposition('')).toBe('');
    expect(nameFromContentDisposition('inline')).toBe('');
  });
});

describe('safeFileName', () => {
  test('drops directories and characters share targets refuse', () => {
    expect(safeFileName('../DCIM/a:b*?.jpg')).toBe('a_b__.jpg');
    expect(safeFileName('C:\\x\\y.png')).toBe('y.png');
    expect(safeFileName('..')).toBe('');
  });
});

describe('downloadFileName', () => {
  const asset = { hash: 'abcdef0123', originalName: 'IMG_1234.HEIC', mediaType: 'photo' };

  test('uses the name the server gives the download', () => {
    expect(downloadFileName(asset, { 'Content-Disposition': `inline; filename="IMG_1234.jpg"; filename*=UTF-8''IMG_1234.jpg` }))
      .toBe('IMG_1234.jpg');
  });

  test('without it, the original name with the format the server sent', () => {
    expect(downloadFileName(asset, { 'content-type': 'image/jpeg' })).toBe('IMG_1234.jpg');
    expect(downloadFileName(asset, {})).toBe('IMG_1234.heic');
  });

  test('a photo with no known name still gets a usable one', () => {
    expect(downloadFileName({ hash: 'abcdef0123', mediaType: 'video' }, { 'Content-Type': 'video/quicktime' })).toBe('photo_abcdef01.mov');
    expect(downloadFileName({ hash: 'abcdef0123', mediaType: 'video' }, undefined)).toBe('photo_abcdef01.mp4');
    expect(downloadFileName({ hash: 'abcdef0123' }, {})).toBe('photo_abcdef01.jpg');
  });
});
