import * as SecureStore from 'expo-secure-store';

// Lite mode: backup, free up space and viewing only -- no AI indexing, search, faces,
// map or duplicate cleanup. Kept apart from 'lomorage_ai_enabled' so turning Lite off
// restores whatever AI choice the user had.
export const LITE_MODE_KEY = 'lomorage_lite_mode';
export const AI_ENABLED_KEY = 'lomorage_ai_enabled';

export async function isLiteMode() {
  return (await SecureStore.getItemAsync(LITE_MODE_KEY)) === 'true';
}

// Whether background AI work may run: AI switched on and not in Lite mode.
export async function isAiAllowed() {
  const [ai, lite] = await Promise.all([
    SecureStore.getItemAsync(AI_ENABLED_KEY),
    SecureStore.getItemAsync(LITE_MODE_KEY),
  ]);
  return ai !== 'false' && lite !== 'true';
}
