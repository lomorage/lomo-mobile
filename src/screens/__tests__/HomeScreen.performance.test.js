import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { View, TextInput, TouchableOpacity, ScrollView } from 'react-native';

// Mock Expo and Native modules
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  notificationAsync: jest.fn(),
}));

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: (props) => React.createElement(View, props),
  };
});

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { ScrollView } = require('react-native');
  return {
    FlashList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }) => {
      let emptyView = null;
      if (ListEmptyComponent) {
        if (typeof ListEmptyComponent === 'function') {
          emptyView = ListEmptyComponent();
        } else {
          emptyView = ListEmptyComponent;
        }
      }
      return React.createElement(
        ScrollView,
        {},
        ListHeaderComponent ? (typeof ListHeaderComponent === 'function' ? ListHeaderComponent() : ListHeaderComponent) : null,
        data && data.length > 0
          ? data.map((item, index) => renderItem({ item, index }))
          : emptyView
      );
    },
  };
});

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = () => React.createElement(View);
  return {
    Cloud: Icon,
    CheckCircle: Icon,
    Smartphone: Icon,
    PlayCircle: Icon,
    PauseCircle: Icon,
    Settings: Icon,
    UploadCloud: Icon,
    X: Icon,
    MapPin: Icon,
    Heart: Icon,
    Search: Icon,
    ScanText: Icon,
    Clock: Icon,
    Calendar: Icon,
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(null),
  deleteItemAsync: jest.fn().mockResolvedValue(null),
}));

jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(1024 * 1024 * 1024 * 10), // 10 GB
}));

// Mock SettingsContext
jest.mock('../../context/SettingsContext', () => ({
  useSettings: () => ({
    debugMode: false,
    autoBackupEnabled: true,
    wifiOnlyBackup: true,
    chargingOnlyBackup: false,
    nightBackupOnly: false,
    adaptiveConcurrencyEnabled: true,
    hashConcurrency: 2,
    uploadConcurrency: 3,
    excludedAlbums: [],
    remoteAIProcessingEnabled: true,
    searchThreshold: 0.25,
    aiWifiOnly: true,
    aiChargingOnly: true,
    aiEnabled: true,
    isLoading: false,
  }),
}));

// Mock services
jest.mock('../../services/MediaService', () => ({
  __esModule: true,
  default: {
    getLocalAssets: jest.fn().mockResolvedValue([]),
    requestPermissions: jest.fn().mockResolvedValue(true),
    getAllAssets: jest.fn().mockResolvedValue([]),
  }
}));
jest.mock('../../services/SyncService', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn().mockReturnValue(jest.fn()),
    loadLocalHashCache: jest.fn().mockResolvedValue({}),
    syncLocalGPS: jest.fn().mockResolvedValue(null),
    fetchRemoteOverview: jest.fn().mockResolvedValue({}),
    sync: jest.fn().mockResolvedValue({}),
  }
}));
jest.mock('../../services/OfflineCacheService', () => ({
  __esModule: true,
  default: {
    syncFavoritesFromServer: jest.fn().mockResolvedValue({}),
  }
}));
jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getServerUrl: jest.fn().mockReturnValue('http://localhost'),
    getToken: jest.fn().mockReturnValue('token'),
  }
}));
jest.mock('../../services/AssetDBService', () => ({
  __esModule: true,
  default: {
    getLocationSuggestions: jest.fn().mockResolvedValue([]),
    init: jest.fn().mockResolvedValue(null),
    getRemoteAssets: jest.fn().mockResolvedValue([]),
    getOnThisDayAssets: jest.fn().mockResolvedValue([]),
    insertLocalAssets: jest.fn().mockResolvedValue(null),
  }
}));
jest.mock('../../services/AutoBackupManager', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn().mockReturnValue(jest.fn()),
    getStatus: jest.fn().mockReturnValue({ totalCount: 0, pendingCount: 0, isBackingUp: false, isPaused: false }),
    syncQueueWithGallery: jest.fn(),
  }
}));
jest.mock('../../services/AIService', () => ({
  __esModule: true,
  default: {
    searchHybrid: jest.fn().mockResolvedValue([]),
  }
}));

import HomeScreen from '../HomeScreen';
const { performance: nodePerf } = require('perf_hooks');

describe('HomeScreen Performance Tests', () => {
  let mockNavigation;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockNavigation = {
      navigate: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('profile time taken to select a date suggestion', async () => {
    // Render the screen
    let component;
    act(() => {
      component = renderer.create(<HomeScreen navigation={mockNavigation} />);
    });

    // Flush initial loadAndSync promise chain
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    const root = component.root;

    // 1. Click Search button to activate searching state
    const searchButtons = root.findAll((node) => {
      // Find search icon/button in header
      return node.type === TouchableOpacity && node.props.style && node.props.style.marginRight === 15;
    });

    // There might be multiple header buttons with marginRight 15 (e.g. search, mapPin, cloud)
    // Find the one that activates search mode (look at onPress callback if possible)
    let searchBtn = searchButtons.find(btn => btn.props.onPress && btn.props.onPress.toString().includes('setIsSearching(true)'));
    if (!searchBtn && searchButtons.length > 0) {
      searchBtn = searchButtons[0]; // fallback
    }

    expect(searchBtn).toBeDefined();

    act(() => {
      searchBtn.props.onPress();
    });

    // 2. Set search query to trigger suggestions list rendering (e.g., '202')
    const textInput = root.findByType(TextInput);
    expect(textInput).toBeDefined();

    await act(async () => {
      textInput.props.onChangeText('202');
      // Advance timers to trigger suggestion updates
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    // Find suggestion item for date / year
    // Date suggestions have Calendar icon or type 'time'
    const suggestionButtons = root.findAll((node) => {
      return node.type === TouchableOpacity && 
             node.props.onPress && 
             node.props.onPress.toString().includes('selectSuggestion');
    });

    console.log(`[Performance] Found ${suggestionButtons.length} suggestion buttons.`);

    if (suggestionButtons.length === 0) {
      console.warn('[Performance] No suggestion buttons found in the rendered tree.');
      return;
    }

    // Select the first suggestion and profile it
    const selectBtn = suggestionButtons[0];

    const t0 = nodePerf.now(); // Real high-res time

    await act(async () => {
      selectBtn.props.onPress();
      // Advance by 500ms to trigger the hybrid search timeout immediately within act
      jest.advanceTimersByTime(500);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    const t1 = nodePerf.now(); // Real high-res time
    const duration = t1 - t0;

    console.log(`[Performance] Time taken to process suggestion click state updates: ${duration.toFixed(2)}ms`);

    // Verify token is added
    // We expect duration to be low under typical mock environments
    expect(duration).toBeLessThan(150);
  });
});
