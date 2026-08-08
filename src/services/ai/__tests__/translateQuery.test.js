import axios from 'axios';
import { containsChinese, translateToEnglish, LOCAL_TRANSLATION_DICT } from '../translateQuery';

jest.mock('axios');

beforeEach(() => {
  axios.get.mockReset();
});

describe('containsChinese', () => {
  test('detects Chinese characters', () => {
    expect(containsChinese('猫')).toBe(true);
    expect(containsChinese('dog 狗狗')).toBe(true);
  });

  test('returns false for pure English/numeric text', () => {
    expect(containsChinese('cat')).toBe(false);
    expect(containsChinese('2024-03-05')).toBe(false);
    expect(containsChinese('')).toBe(false);
  });
});

describe('translateToEnglish', () => {
  test('returns non-Chinese input unchanged without calling the network', async () => {
    const result = await translateToEnglish('cat beach');
    expect(result).toBe('cat beach');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('uses the local dictionary for a known phrase, without calling the network', async () => {
    const result = await translateToEnglish('猫');
    expect(result).toBe(LOCAL_TRANSLATION_DICT['猫']);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('is case/whitespace-insensitive when matching the local dictionary', async () => {
    const result = await translateToEnglish('  猫咪  ');
    expect(result).toBe('cat');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('falls back to the online translate API for a Chinese phrase not in the dictionary', async () => {
    axios.get.mockResolvedValue({ data: [[['sunset over the mountains']]] });
    const result = await translateToEnglish('山上的日落');
    expect(result).toBe('sunset over the mountains');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://translate.googleapis.com/translate_a/single'),
      expect.objectContaining({ timeout: 5000, skipAutoProbe: true })
    );
  });

  test('falls back to the original text when the online API rejects', async () => {
    axios.get.mockRejectedValue(new Error('network error'));
    const result = await translateToEnglish('山上的日落');
    expect(result).toBe('山上的日落');
  });

  test('falls back to the original text when the online API returns an unexpected shape', async () => {
    axios.get.mockResolvedValue({ data: null });
    const result = await translateToEnglish('山上的日落');
    expect(result).toBe('山上的日落');
  });
});
