import { processBlocksToMetadata } from '../ocrUtils';

describe('processBlocksToMetadata', () => {
  const asset = { width: 1000, height: 500 };

  test('returns null when result is missing', () => {
    expect(processBlocksToMetadata(null, asset)).toBeNull();
  });

  test('returns null when result has no blocks', () => {
    expect(processBlocksToMetadata({}, asset)).toBeNull();
  });

  test('returns null when asset has no width/height', () => {
    const result = { blocks: [{ text: 'hi', frame: { left: 0, top: 0, right: 10, bottom: 10 } }] };
    expect(processBlocksToMetadata(result, {})).toBeNull();
  });

  test('normalizes pixel frames to 0-1 fractional coordinates relative to asset size', () => {
    const result = {
      blocks: [
        { text: 'Hello', frame: { left: 100, top: 50, right: 300, bottom: 150 } },
      ],
    };
    const blocksList = processBlocksToMetadata(result, asset);
    expect(blocksList).toEqual([
      { text: 'Hello', frame: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    ]);
  });

  test('skips blocks without a frame', () => {
    const result = {
      blocks: [
        { text: 'no frame here' },
        { text: 'has frame', frame: { left: 0, top: 0, right: 1000, bottom: 500 } },
      ],
    };
    const blocksList = processBlocksToMetadata(result, asset);
    expect(blocksList).toHaveLength(1);
    expect(blocksList[0].text).toBe('has frame');
  });

  test('preserves block order and count across multiple blocks', () => {
    const result = {
      blocks: [
        { text: 'A', frame: { left: 0, top: 0, right: 100, bottom: 100 } },
        { text: 'B', frame: { left: 100, top: 100, right: 200, bottom: 200 } },
        { text: 'C', frame: { left: 200, top: 200, right: 300, bottom: 300 } },
      ],
    };
    const blocksList = processBlocksToMetadata(result, asset);
    expect(blocksList.map(b => b.text)).toEqual(['A', 'B', 'C']);
  });
});
