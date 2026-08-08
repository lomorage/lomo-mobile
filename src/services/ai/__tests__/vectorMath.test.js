import { cosineSimilarity } from '../vectorMath';

describe('cosineSimilarity', () => {
  test('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  test('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  test('compares only the overlapping length when vectors differ in size', () => {
    // Only the first 2 dimensions are compared, so the trailing values are ignored.
    const a = [1, 0, 999];
    const b = [1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });

  test('works with typed arrays (Float32Array), matching real embedding usage', () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});
