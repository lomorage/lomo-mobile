import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(),
}));
// SettingsContext.js accesses this via a raw `require('../services/AIService').default`
// (not a static import), so the mock must expose `.default` itself for that to resolve.
jest.mock('../../services/AIService', () => {
  const mock = {
    syncEmbeddings: jest.fn().mockResolvedValue(),
    registerBackgroundSync: jest.fn(),
    unregisterBackgroundSync: jest.fn(),
    processLocalEmbeddings: jest.fn().mockResolvedValue(),
  };
  return { __esModule: true, default: mock, ...mock };
});

const SecureStore = require('expo-secure-store');
const AIService = require('../../services/AIService');
import { SettingsProvider, useSettings } from '../SettingsContext';

let latestSettings;
function Consumer() {
  latestSettings = useSettings();
  return null;
}

async function renderSettingsProvider() {
  let root;
  await act(async () => {
    root = renderer.create(<SettingsProvider><Consumer /></SettingsProvider>);
  });
  return root;
}

// Flushes the microtask queue enough times for a toggle's fire-and-forget
// `import('react-native').then(...)` (or `require(...)` background sync) call
// to resolve and run, since the toggle functions don't await those.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.getItemAsync.mockResolvedValue(null);
  SecureStore.setItemAsync.mockResolvedValue();
  latestSettings = undefined;
});

describe('loadSettings (mount)', () => {
  test('uses hardcoded defaults when nothing is persisted yet', async () => {
    await renderSettingsProvider();
    expect(latestSettings.debugMode).toBe(false);
    expect(latestSettings.autoBackupEnabled).toBe(true);
    expect(latestSettings.hashConcurrency).toBe(2);
    expect(latestSettings.searchThreshold).toBe(0.25);
    expect(latestSettings.excludedAlbums).toEqual([]);
    expect(latestSettings.isLoading).toBe(false);
  });

  test('restores persisted boolean/number/JSON values, overriding the defaults', async () => {
    SecureStore.getItemAsync.mockImplementation((key) => {
      const values = {
        lomorage_debug_mode: 'true',
        lomorage_hash_concurrency: '5',
        lomorage_search_threshold: '0.4',
        lomorage_excluded_albums: JSON.stringify(['album1', 'album2']),
      };
      return Promise.resolve(key in values ? values[key] : null);
    });

    await renderSettingsProvider();

    expect(latestSettings.debugMode).toBe(true);
    expect(latestSettings.hashConcurrency).toBe(5);
    expect(latestSettings.searchThreshold).toBe(0.4);
    expect(latestSettings.excludedAlbums).toEqual(['album1', 'album2']);
  });

  test('malformed excludedAlbums JSON is caught, falling back to the default empty list', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_excluded_albums' ? 'not valid json{' : null)
    );
    await renderSettingsProvider();
    expect(latestSettings.excludedAlbums).toEqual([]);
    expect(latestSettings.isLoading).toBe(false);
  });

  test('isLoading still clears (does not hang) when SecureStore itself throws', async () => {
    SecureStore.getItemAsync.mockRejectedValue(new Error('keychain unavailable'));
    await renderSettingsProvider();
    expect(latestSettings.isLoading).toBe(false);
  });
});

describe('a representative simple toggle (toggleDebugMode)', () => {
  test('persists the new value and flips the state', async () => {
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.toggleDebugMode();
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomorage_debug_mode', 'true');
    expect(latestSettings.debugMode).toBe(true);
  });

  test('leaves state unchanged when the SecureStore write fails', async () => {
    await renderSettingsProvider();
    SecureStore.setItemAsync.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await latestSettings.toggleDebugMode();
    });
    expect(latestSettings.debugMode).toBe(false);
  });
});

describe('toggleAlbumExclusion', () => {
  test('adds an album id that is not yet excluded', async () => {
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.toggleAlbumExclusion('album1');
    });
    expect(latestSettings.excludedAlbums).toEqual(['album1']);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomorage_excluded_albums', JSON.stringify(['album1']));
  });

  test('removes an album id that is already excluded', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_excluded_albums' ? JSON.stringify(['album1', 'album2']) : null)
    );
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.toggleAlbumExclusion('album1');
    });
    expect(latestSettings.excludedAlbums).toEqual(['album2']);
  });
});

describe('AI-related toggles trigger the right AIService calls', () => {
  test('toggleAIEnabled(false -> true) triggers processing and registers background sync', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_ai_enabled' ? 'false' : null)
    );
    await renderSettingsProvider();
    expect(latestSettings.aiEnabled).toBe(false);

    await act(async () => {
      await latestSettings.toggleAIEnabled();
    });
    await flushMicrotasks();

    expect(latestSettings.aiEnabled).toBe(true);
    expect(AIService.processLocalEmbeddings).toHaveBeenCalledWith(30);
    expect(AIService.registerBackgroundSync).toHaveBeenCalled();
  });

  test('toggleAIEnabled(true -> false) unregisters background sync instead', async () => {
    await renderSettingsProvider();
    expect(latestSettings.aiEnabled).toBe(true);

    await act(async () => {
      await latestSettings.toggleAIEnabled();
    });
    await flushMicrotasks();

    expect(AIService.unregisterBackgroundSync).toHaveBeenCalled();
    expect(AIService.processLocalEmbeddings).not.toHaveBeenCalled();
  });

  test('toggleRemoteAIProcessing(true) syncs immediately and registers background sync when AI is enabled', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'lomorage_remote_ai_processing' ? 'false' : null)
    );
    await renderSettingsProvider();
    expect(latestSettings.aiEnabled).toBe(true);

    await act(async () => {
      await latestSettings.toggleRemoteAIProcessing();
    });

    expect(AIService.syncEmbeddings).toHaveBeenCalledWith(true);
    expect(AIService.registerBackgroundSync).toHaveBeenCalled();
  });

  test('toggleRemoteAIProcessing(false) unregisters background sync', async () => {
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.toggleRemoteAIProcessing();
    });
    expect(AIService.unregisterBackgroundSync).toHaveBeenCalled();
  });
});

describe('updateSearchThreshold / updateHashConcurrency', () => {
  test('updateSearchThreshold persists and updates the value', async () => {
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.updateSearchThreshold(0.5);
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('lomorage_search_threshold', '0.5');
    expect(latestSettings.searchThreshold).toBe(0.5);
  });

  test('updateHashConcurrency persists and updates the value', async () => {
    await renderSettingsProvider();
    await act(async () => {
      await latestSettings.updateHashConcurrency(4);
    });
    expect(latestSettings.hashConcurrency).toBe(4);
  });
});
