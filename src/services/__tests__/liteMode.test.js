jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn() }));

const SecureStore = require('expo-secure-store');
import { isAiAllowed, isLiteMode } from '../liteMode';

const store = (values) => SecureStore.getItemAsync.mockImplementation(async (key) => values[key] ?? null);

test.each([
  [{}, true],
  [{ lomorage_ai_enabled: 'true' }, true],
  [{ lomorage_ai_enabled: 'false' }, false],
  [{ lomorage_lite_mode: 'true' }, false],
  [{ lomorage_ai_enabled: 'true', lomorage_lite_mode: 'true' }, false],
  [{ lomorage_ai_enabled: 'true', lomorage_lite_mode: 'false' }, true],
])('isAiAllowed with %j -> %s', async (values, expected) => {
  store(values);
  await expect(isAiAllowed()).resolves.toBe(expected);
});

test('isLiteMode reads the Lite switch', async () => {
  store({ lomorage_lite_mode: 'true' });
  await expect(isLiteMode()).resolves.toBe(true);
  store({});
  await expect(isLiteMode()).resolves.toBe(false);
});
