import { buildImageDataUri } from '../base64Image';

describe('buildImageDataUri', () => {
  test('returns null for empty/missing input', () => {
    expect(buildImageDataUri('')).toBeNull();
    expect(buildImageDataUri(null)).toBeNull();
    expect(buildImageDataUri(undefined)).toBeNull();
  });

  test('passes through a string that is already a data: URI unchanged', () => {
    expect(buildImageDataUri('data:image/png;base64,abc123')).toBe('data:image/png;base64,abc123');
  });

  test('labels PNG base64 (iVBORw0KGgo prefix) as image/png', () => {
    expect(buildImageDataUri('iVBORw0KGgoAAAANSUhEUgAA')).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA');
  });

  test('defaults to image/jpeg for anything else (e.g. JPEG /9j/ prefix)', () => {
    expect(buildImageDataUri('/9j/4AAQSkZJRgABAQAA')).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA');
  });
});
