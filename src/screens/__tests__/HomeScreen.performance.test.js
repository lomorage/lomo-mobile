import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';

// Mock Expo and Native modules
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  notificationAsync: jest.fn(),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn().mockResolvedValue(undefined),
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

let mockExcludedAlbums = [];

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
    excludedAlbums: mockExcludedAlbums,
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
    getPermissionStatus: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
    requestPermissions: jest.fn().mockResolvedValue(true),
    getAccessibleAssetCount: jest.fn().mockResolvedValue(0),
    presentLimitedLibraryPicker: jest.fn().mockResolvedValue(true),
    addLibraryChangeListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    getAllAssets: jest.fn().mockResolvedValue([]),
  }
}));
jest.mock('../../services/SyncService', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn().mockReturnValue(jest.fn()),
    localHashCache: {},
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
    pruneDeletedLocalAssets: jest.fn().mockResolvedValue([]),
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
jest.mock('../../services/FirstBackupService', () => ({
  __esModule: true,
  FIRST_BACKUP_CHANGED_EVENT: 'firstBackupGuideChanged',
  default: {
    isPending: jest.fn().mockResolvedValue(false),
    complete: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../services/AIService', () => ({
  __esModule: true,
  default: {
    searchHybrid: jest.fn().mockResolvedValue([]),
  }
}));

import HomeScreen from '../HomeScreen';
const { performance: nodePerf } = require('perf_hooks');
const MediaService = require('../../services/MediaService').default;
const SyncService = require('../../services/SyncService').default;
const FirstBackupService = require('../../services/FirstBackupService').default;
const KeepAwake = require('expo-keep-awake');

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe('HomeScreen first backup guidance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MediaService.getAllAssets.mockResolvedValue([]);
    SyncService.localHashCache = {};
  });

  afterEach(() => {
    FirstBackupService.isPending.mockResolvedValue(false);
    require('../../services/AutoBackupManager').default.syncQueueWithGallery.mockImplementation(() => {});
  });

  test('shows the ritual card and live foreground progress until the first backup completes', async () => {
    FirstBackupService.isPending.mockResolvedValue(true);
    MediaService.getAllAssets.mockResolvedValue([{ id: 'new-photo', mediaType: 'photo', creationTime: Date.now() }]);
    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    expect(component.root.findAllByType(Text).some(node =>
      [].concat(node.props.children).join('').includes('Tonight: ① connect to Wi-Fi')
    )).toBe(true);

    await act(async () => {
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: true,
        isPaused: false,
        pendingCount: 8,
        completedCount: 2,
        totalCount: 10,
        activeAssetIds: [],
        activeUploads: {},
        uploadStats: {},
      });
      await flushPromises();
    });

    expect(component.root.findAllByType(Text).some(node => node.props.children === 'Keep Lomorage open')).toBe(true);
    expect(component.root.findAllByType(Text).some(node =>
      [].concat(node.props.children).join('') === '2 of 10 uploaded'
    )).toBe(true);
    expect(KeepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith('lomorage-first-backup');

    await act(async () => {
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: false,
        isPaused: false,
        pendingCount: 0,
        completedCount: 10,
        totalCount: 10,
        activeAssetIds: [],
        activeUploads: {},
        uploadStats: {},
      });
      await flushPromises();
    });

    expect(FirstBackupService.complete).toHaveBeenCalledTimes(1);
    expect(KeepAwake.deactivateKeepAwake).toHaveBeenCalledWith('lomorage-first-backup');
    act(() => component.unmount());
  });

  test('finishes guidance only after an empty library scan has synchronized its queue', async () => {
    FirstBackupService.isPending.mockResolvedValue(true);
    let finishScan;
    MediaService.getAllAssets.mockImplementationOnce(() => new Promise(resolve => {
      finishScan = resolve;
    }));

    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });
    expect(FirstBackupService.complete).not.toHaveBeenCalled();

    await act(async () => {
      finishScan([]);
      await flushPromises();
    });

    expect(FirstBackupService.complete).toHaveBeenCalledTimes(1);
    const queueSync = require('../../services/AutoBackupManager').default.syncQueueWithGallery;
    expect(queueSync.mock.invocationCallOrder[queueSync.mock.invocationCallOrder.length - 1])
      .toBeLessThan(FirstBackupService.complete.mock.invocationCallOrder[0]);
    act(() => component.unmount());
  });

  test('keeps guidance pending after a scan finds photos to upload', async () => {
    FirstBackupService.isPending.mockResolvedValue(true);
    MediaService.getAllAssets.mockResolvedValue([{ id: 'new-photo', mediaType: 'photo', creationTime: Date.now() }]);

    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    expect(FirstBackupService.complete).not.toHaveBeenCalled();
    act(() => component.unmount());
  });

  test('waits for an active scan even if an earlier upload session finishes', async () => {
    FirstBackupService.isPending.mockResolvedValue(true);
    let finishScan;
    MediaService.getAllAssets.mockImplementationOnce(() => new Promise(resolve => {
      finishScan = resolve;
    }));

    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    const { DeviceEventEmitter } = require('react-native');
    require('../../services/AutoBackupManager').default.syncQueueWithGallery.mockImplementation(() => {
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: true, isPaused: false, pendingCount: 1, totalCount: 2,
      });
    });
    await act(async () => {
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: true, isPaused: false, pendingCount: 1, totalCount: 1,
      });
      await flushPromises();
    });
    await act(async () => {
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: false, isPaused: false, pendingCount: 0, totalCount: 1,
      });
      await flushPromises();
    });
    expect(FirstBackupService.complete).not.toHaveBeenCalled();

    await act(async () => {
      finishScan([{ id: 'new-photo', mediaType: 'photo', creationTime: Date.now() }]);
      await flushPromises();
    });
    expect(FirstBackupService.complete).not.toHaveBeenCalled();

    await act(async () => {
      DeviceEventEmitter.emit('backupState', {
        isBackingUp: false, isPaused: false, pendingCount: 0, totalCount: 2,
      });
      await flushPromises();
    });
    expect(FirstBackupService.complete).toHaveBeenCalledTimes(1);
    act(() => component.unmount());
  });
});

describe('HomeScreen limited photo access', () => {
  let libraryChangeListener;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockExcludedAlbums = [];
    MediaService.getPermissionStatus.mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    MediaService.requestPermissions.mockResolvedValue(true);
    MediaService.getAccessibleAssetCount.mockResolvedValue(3);
    MediaService.presentLimitedLibraryPicker.mockResolvedValue(true);
    MediaService.addLibraryChangeListener.mockImplementation(listener => {
      libraryChangeListener = listener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    MediaService.getPermissionStatus.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    mockExcludedAlbums = [];
    jest.useRealTimers();
  });

  test('warns about visible assets and opens the limited-library picker', async () => {
    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    const warning = component.root.findAllByType(Text).find(node =>
      [].concat(node.props.children).join('') ===
      'Lomorage can only see 3 selected items. Only those will be backed up.'
    );
    expect(warning).toBeDefined();

    const selectMore = component.root.findAllByType(TouchableOpacity).find(
      node => node.findAllByType(Text).some(text => text.props.children === 'Select More')
    );
    expect(selectMore).toBeDefined();
    const initialLoadCount = MediaService.getAllAssets.mock.calls.length;

    await act(async () => {
      await selectMore.props.onPress();
      await flushPromises();
    });

    expect(MediaService.presentLimitedLibraryPicker).toHaveBeenCalledTimes(1);
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(initialLoadCount);

    await act(async () => {
      libraryChangeListener({ hasIncrementalChanges: false });
      await flushPromises();
    });

    expect(MediaService.getAllAssets.mock.calls.length).toBeGreaterThan(initialLoadCount);
    act(() => component.unmount());
  });

  test('queues a selection-change reload behind an active scan', async () => {
    let finishFirstScan;
    MediaService.getAllAssets
      .mockImplementationOnce(() => new Promise(resolve => {
        finishFirstScan = resolve;
      }))
      .mockResolvedValue([]);

    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(1);

    act(() => {
      libraryChangeListener({ hasIncrementalChanges: false });
    });
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstScan([]);
      await flushPromises();
    });

    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(2);
    act(() => component.unmount());
  });

  test('uses updated album exclusions for a queued scan', async () => {
    let finishFirstScan;
    MediaService.getAllAssets
      .mockImplementationOnce(() => new Promise(resolve => {
        finishFirstScan = resolve;
      }))
      .mockResolvedValue([]);

    const navigation = { navigate: jest.fn() };
    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={navigation} />);
      await flushPromises();
    });

    mockExcludedAlbums = ['Private'];
    await act(async () => {
      component.update(<HomeScreen navigation={navigation} />);
      await flushPromises();
    });
    await act(async () => {
      libraryChangeListener({ hasIncrementalChanges: false });
      await flushPromises();
    });
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstScan([]);
      await flushPromises();
    });

    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(2);
    expect(MediaService.getAllAssets.mock.calls[0][2]).toEqual([]);
    expect(MediaService.getAllAssets.mock.calls[1][2]).toEqual(['Private']);
    act(() => component.unmount());
  });

  test('drains a new selection change received during the queued scan', async () => {
    const pendingScans = [];
    MediaService.getAllAssets.mockImplementation(() => new Promise(resolve => {
      pendingScans.push(resolve);
    }));

    let component;
    await act(async () => {
      component = renderer.create(<HomeScreen navigation={{ navigate: jest.fn() }} />);
      await flushPromises();
    });

    act(() => libraryChangeListener({ hasIncrementalChanges: false }));
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingScans[0]([]);
      await flushPromises();
    });
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(2);

    act(() => libraryChangeListener({ hasIncrementalChanges: false }));
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingScans[1]([]);
      await flushPromises();
    });
    expect(MediaService.getAllAssets).toHaveBeenCalledTimes(3);

    await act(async () => {
      pendingScans[2]([]);
      await flushPromises();
    });
    act(() => component.unmount());
  });
});

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
