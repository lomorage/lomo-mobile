import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { StyleSheet, View, Dimensions, TouchableOpacity, Text, ActivityIndicator, RefreshControl, DeviceEventEmitter, AppState, PanResponder, Animated, Modal, TextInput, ScrollView, Alert, Platform, Keyboard, Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { Cloud, CheckCircle, Smartphone, PlayCircle, PauseCircle, Settings as SettingsIcon, UploadCloud, X, MapPin, Heart, Search, ScanText, Clock, Calendar, WifiOff, Images as ImagesIcon } from 'lucide-react-native';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import OfflineCacheService from '../services/OfflineCacheService';
import AssetDBService from '../services/AssetDBService';
import AutoBackupManager from '../services/AutoBackupManager';
import AIService from '../services/AIService';
import { useSettings } from '../context/SettingsContext';
import GalleryStore from '../store/GalleryStore';
import ThumbnailLoadTracker from '../services/ThumbnailLoadTracker';
import MetricsTracker from '../utils/MetricsTracker';
import { formatBytes, formatSpeed } from '../utils/formatters';
import { isVideoExtension } from '../utils/mediaType';
import { isLivePhoto } from '../utils/livePhoto';
import { parseTimeTokenExtra } from './homeScreenHelpers';
import * as SecureStore from 'expo-secure-store';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { pinyin } from 'pinyin-pro';

const { width } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const ITEM_SIZE = width / COLUMN_COUNT;

// Grid thumbnails intentionally skip the memory cache. We tried gating this on
// Device.totalMemory (memory-disk above 4GB), but confirmed on a real 11.8GB-RAM
// device mid-sync that total installed RAM doesn't predict *available* RAM under
// real-world system pressure — the OS low-memory-killer still took the app down
// (logcat: "lowmemorykiller: Kill 'com.wtao.lomo' ... reason: low watermark is
// breached", other apps killed in the same window). Disk-only avoids that class
// of crash entirely; re-decoding on scroll-back is a cheaper trade than an OOM kill.
const GRID_IMAGE_CACHE_POLICY = 'disk';

const SMART_TAGS = [
    { label: '🐱 Cats', query: 'cat' },
    { label: '🐶 Dogs', query: 'dog' },
    { label: '🍔 Food', query: 'food' },
    { label: '🌅 Beach', query: 'beach' },
    { label: '🏞️ Landscape', query: 'landscape' },
    { label: '🌸 Flowers', query: 'flower' },
    { label: '📄 Screenshots', query: 'screenshot' },
    { label: '🚗 Cars', query: 'car' },
    { label: '👶 Babies', query: 'baby' },
    { label: '🌲 Forests', query: 'forest' },
    { label: '🏔️ Mountains', query: 'snowy mountain' },
    { label: '🌃 Night Views', query: 'night view' },
    { label: '🏠 Buildings', query: 'building' },
    { label: '☕ Coffee', query: 'coffee' },
    { label: '🚲 Bicycles', query: 'bicycle' },
    { label: '⚽ Sports', query: 'sports' },
    { label: '✈️ Travel', query: 'travel' },
    { label: '🌊 Oceans', query: 'ocean' },
    { label: '🍁 Autumn Leaves', query: 'autumn leaves' },
    { label: '🎸 Music', query: 'musical instrument' }
];

const TIME_TAGS = [
    { label: '📅 Yesterday', query: 'yesterday', type: 'time' },
    { label: '📅 Last Week', query: 'last week', type: 'time' },
    { label: '📅 Last Month', query: 'last month', type: 'time' },
    { label: '📅 This Year', query: 'this year', type: 'time' },
    { label: '📅 Last Year', query: 'last year', type: 'time' }
];

const COMBINED_TAGS = [...TIME_TAGS, ...SMART_TAGS.map(t => ({...t, type: 'semantic'}))];

const LivePhotoIcon = ({ color = '#fff', size = 14 }) => {
    const innerSize = size * 0.45;
    const middleSize = size * 0.75;
    return (
        <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
            {/* Outer dashed concentric ring */}
            <View style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 1,
                borderColor: color,
                borderStyle: 'dashed',
                opacity: 0.8
            }} />
            {/* Middle solid ring */}
            <View style={{
                position: 'absolute',
                width: middleSize,
                height: middleSize,
                borderRadius: middleSize / 2,
                borderWidth: 1,
                borderColor: color,
                opacity: 0.9
            }} />
            {/* Center solid dot */}
            <View style={{
                width: innerSize,
                height: innerSize,
                borderRadius: innerSize / 2,
                backgroundColor: color
            }} />
        </View>
    );
};

const SwipeableBanner = ({ info, onPress, onDismiss, styles }) => {
    const pan = useRef(new Animated.ValueXY()).current;
    const panResponder = useRef(
        PanResponder.create({
            onMoveShouldSetPanResponder: (evt, gestureState) => {
                return Math.abs(gestureState.dx) > 20 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
            },
            onPanResponderMove: Animated.event(
                [null, { dx: pan.x }],
                { useNativeDriver: false }
            ),
            onPanResponderRelease: (evt, gestureState) => {
                if (gestureState.dx > 100 || gestureState.dx < -100) {
                    Animated.timing(pan, {
                        toValue: { x: gestureState.dx > 0 ? width : -width, y: 0 },
                        duration: 200,
                        useNativeDriver: true
                    }).start(() => {
                        if (onDismiss) onDismiss();
                    });
                } else {
                    Animated.spring(pan, {
                        toValue: { x: 0, y: 0 },
                        useNativeDriver: true
                    }).start();
                }
            }
        })
    ).current;

    return (
        <View style={[styles.smartBannerContainer, { overflow: 'hidden' }]}>
            <Animated.View
                style={{ transform: [{ translateX: pan.x }] }}
                {...panResponder.panHandlers}
            >
                <TouchableOpacity 
                    style={styles.smartBanner}
                    onPress={onPress}
                    activeOpacity={0.9}
                >
                    <View style={styles.smartBannerContent}>
                        <Text style={styles.smartBannerTitle}>Free Up Space</Text>
                        <Text style={styles.smartBannerText}>Phone storage is low. Found {info.count} large backed-up videos to clean. Swipe to dismiss.</Text>
                    </View>
                    <View style={styles.smartBannerButton}>
                        <Text style={styles.smartBannerButtonText}>Clean</Text>
                    </View>
                </TouchableOpacity>
            </Animated.View>
        </View>
    );
};

export default function HomeScreen({ navigation, route }) {
    const [assets, setAssets] = useState([]);
    const [onThisDayAssets, setOnThisDayAssets] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState(null);
    const [backupState, setBackupState] = useState({ isBackingUp: false, pendingCount: 0, totalCount: 0, currentAssetId: null });
    const [backupProgress, setBackupProgress] = useState(0);
    const [activeUploads, setActiveUploads] = useState({});
    const [uploadStats, setUploadStats] = useState({});
    const [isBottomSheetVisible, setBottomSheetVisible] = useState(false);
    const [freeUpSpaceInfo, setFreeUpSpaceInfo] = useState({ visible: false, count: 0, loading: false });
    const [error, setError] = useState(null);
    const [permissionStatus, setPermissionStatus] = useState('granted');
    const [loading, setLoading] = useState(true);

    const [isSearching, setIsSearching] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isSearchLoading, setIsSearchLoading] = useState(false);
    const [searchTokens, setSearchTokens] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [suggestionTrigger, setSuggestionTrigger] = useState(0);
    const [headerHeight, setHeaderHeight] = useState(110);
    const [aiStatus, setAiStatus] = useState(null);
    const aiPillOpacity = useRef(new Animated.Value(0)).current;
    const aiPillTimer = useRef(null);
    // Bumped whenever AuthService switches local/remote server URLs, so already-rendered
    // remote thumbnails (which read getServerUrl() once at render time) know to retry.
    const [serverEpoch, setServerEpoch] = useState(0);
    
    const { debugMode, excludedAlbums } = useSettings();
    const [debugLogs, setDebugLogs] = useState([]);

    useEffect(() => {
        if (!debugMode) return;
        const sub = DeviceEventEmitter.addListener('app_debug_log', (log) => {
            setDebugLogs(prev => {
                const newLogs = [...prev, log];
                if (newLogs.length > 20) newLogs.shift();
                return newLogs;
            });
        });
        return () => sub.remove();
    }, [debugMode]);


    const isMounted = useRef(true);
    const isProgrammaticSearchRef = useRef(false);
    const appState = useRef(AppState.currentState);

    const listRef = useRef(null);
    const containerRef = useRef(null);
    const scrubberPageYRef = useRef(0);
    const containerHeightRef = useRef(0);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubText, setScrubText] = useState('');
    const lastScrubTextRef = useRef('');
    const isScrubbingRef = useRef(false);
    const lastScrubIndexRef = useRef(-1);
    const scrubThumbY = useRef(new Animated.Value(0)).current;
    const scrubTooltipY = useRef(new Animated.Value(0)).current;
    const timelineDataRef = useRef([]);
    const stickyHeaderIndicesRef = useRef([]);
    const lastJumpTimeRef = useRef(0);
    const globalActiveLoadCount = useRef(0);
    const pendingAssetUpdates = useRef(new Map());
    const flushTimerRef = useRef(null);

    const hideSuggestionsUntilFocusRef = useRef(false);

    const globalAssetMapRef = useRef(new Map());
    const searchAbortControllerRef = useRef(null);

    const backupStateRef = useRef(backupState);
    useEffect(() => {
        backupStateRef.current = backupState;
    }, [backupState]);

    const assetsRef = useRef([]);
    useEffect(() => {
        assetsRef.current = assets;
    }, [assets]);


    // Handle clicking a Smart Category or Time Tag
    const handleTagPress = (tag) => {
        setIsSearching(true);
        hideSuggestionsUntilFocusRef.current = true;
        Keyboard.dismiss();
        
        // Check if token already exists
        const exists = searchTokens.some(t => t.type === tag.type && t.value === tag.query);
        if (exists) {
            setSuggestionTrigger(prev => prev + 1);
            return;
        }

        const newToken = {
            id: `${tag.type}-tag-${Date.now()}-${Math.random()}`,
            type: tag.type,
            value: tag.query,
            label: tag.label,
            extra: tag.type === 'time' ? parseTimeTokenExtra(tag.query) : undefined
        };
        setSearchTokens(prev => [...prev, newToken]);
        setSearchQuery('');
        setSuggestionTrigger(prev => prev + 1);
    };

    // Autocomplete / Suggestions generator
    useEffect(() => {
        if (!isSearching) {
            setSuggestions([]);
            return;
        }

        const query = searchQuery.trim().toLowerCase();
        let cancel = false;

        const generateSuggestions = async () => {
            // If the user recently selected a token and hasn't tapped the input again, don't show any suggestions.
            if (hideSuggestionsUntilFocusRef.current) {
                if (!cancel) setSuggestions([]);
                return;
            }

            const tempSuggestions = [];

            if (query === '') {
            } else {
                // 1. Time Suggestion matches
                const relativeTimes = ['yesterday', 'last week', 'last month', 'last year', 'this year'];
                for (const rt of relativeTimes) {
                    if (rt.includes(query)) {
                        tempSuggestions.push({
                            id: `time-${rt}`,
                            type: 'time',
                            label: rt.charAt(0).toUpperCase() + rt.slice(1),
                            value: rt,
                            extra: parseTimeTokenExtra(rt)
                        });
                    }
                }

                // Numeric year matches
                const currentYear = new Date().getFullYear();
                for (let y = currentYear; y >= currentYear - 5; y--) {
                    const yStr = y.toString();
                    if (yStr.includes(query) && !tempSuggestions.some(s => s.value === yStr)) {
                        tempSuggestions.push({
                            id: `time-${yStr}`,
                            type: 'time',
                            label: `Year ${yStr}`,
                            value: yStr,
                            extra: parseTimeTokenExtra(yStr)
                        });
                    }
                }

                // 3. Semantic / Smart Tag matches
                for (const tag of SMART_TAGS) {
                    if (tag.label.toLowerCase().includes(query) || tag.query.toLowerCase().includes(query)) {
                        tempSuggestions.push({
                            id: `semantic-${tag.query}`,
                            type: 'semantic',
                            label: tag.label,
                            value: tag.query
                        });
                    }
                }
            }

            // 2. Location Suggestions from SQLite (runs even for empty queries to show top locations)
            try {
                const dbSuggestions = await AssetDBService.getLocationSuggestions(query);
                if (!cancel) {
                    for (const s of dbSuggestions) {
                        tempSuggestions.push({
                            id: `location-${s.type}-${s.name}`,
                            type: 'location',
                            label: `${s.name} (${s.type})`,
                            value: s.name
                        });
                    }
                }
            } catch (e) {
                console.error('[HomeScreen] Failed to get location suggestions:', e);
            }

            if (!cancel) {
                // Filter out suggestions that are already selected in searchTokens
                const finalSuggestions = tempSuggestions.filter(suggestion => 
                    !searchTokens.some(t => t.type === suggestion.type && t.value === suggestion.value)
                );
                setSuggestions(finalSuggestions.slice(0, 10));
            }
        };

        generateSuggestions();

        return () => {
            cancel = true;
        };
    }, [searchQuery, isSearching, suggestionTrigger]);

    // Hybrid Search effect
    useEffect(() => {
        const hasActiveQuery = searchTokens.length > 0 || searchQuery.trim() !== '';
        if (!isSearching || !hasActiveQuery) {
            setSearchResults([]);
            GalleryStore.setAssets([], 'search');
            setIsSearchLoading(false);
            return;
        }

        if (isProgrammaticSearchRef.current) {
            console.log('[HomeScreen] Skipping general search effect (programmatic query:', searchQuery, ')');
            isProgrammaticSearchRef.current = false;
            return;
        }

        // Optimization: Do not clear previous results immediately to avoid UI lag.
        // Let the old results stay visible while searching.
        setIsSearchLoading(true);

        if (searchAbortControllerRef.current) {
            searchAbortControllerRef.current.abort();
        }
        searchAbortControllerRef.current = new AbortController();
        const signal = searchAbortControllerRef.current.signal;

        const timer = setTimeout(async () => {
            try {
                const results = await AIService.searchHybrid(searchTokens, searchQuery, null, 50000, signal);
                if (signal.aborted) return;
                
                const mappedResults = results.map(res => {
                    const matched = globalAssetMapRef.current.get(res.id) || (res.hash ? globalAssetMapRef.current.get(res.hash) : undefined);
                    if (matched) {
                        return { ...matched, score: res.score, isOcrMatch: res.isOcrMatch };
                    }
                    return {
                        ...res,
                        status: res.isLocal ? 'synced' : 'remote',
                        uri: res.isLocal 
                            ? (Platform.OS === 'android' ? `content://media/external/images/media/${res.id}` : `ph://${res.id}`)
                            : MediaService.getPreviewUrl(res.hash, res.mediaType)
                    };
                });

                // Deduplicate by id — multiple DB results can map to the same local asset
                // (e.g. same hash matched via id lookup AND hash lookup), causing duplicate React keys.
                const seenIds = new Set();
                const topResults = mappedResults
                    .sort((a, b) => b.score - a.score)
                    .filter(r => {
                        const key = r.id ?? r.hash;
                        if (!key || seenIds.has(key)) return false;
                        seenIds.add(key);
                        return true;
                    });

                GalleryStore.setAssets(topResults, 'search');
                setSearchResults(topResults);
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[HomeScreen] Search aborted');
                } else {
                    console.error('[HomeScreen] Hybrid search error:', err);
                }
            } finally {
                if (signal && !signal.aborted) setIsSearchLoading(false);
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [searchTokens, searchQuery, isSearching]);

    const isActivelySearching = isSearching && (searchTokens.length > 0 || searchQuery.trim() !== '');

    const activeAssets = useMemo(() => {
        if (isActivelySearching) {
            return searchResults;
        }
        return assets;
    }, [isSearching, searchQuery, searchResults, assets]);

    const localAssetsRef = useRef([]);
    const remoteAssetsListRef = useRef([]);

    const safeUri = useCallback((uri, mediaType) => {
        if (!uri) return null;
        if (uri.startsWith('http')) return uri;
        if (uri.startsWith('content://')) {
            return uri;
        }
        // iOS Photos framework URIs — must be passed as-is to the Image component
        if (uri.startsWith('ph://')) return uri;
        if (uri.startsWith('asset-library://')) return uri;
        
        let path = uri;
        if (path.startsWith('file://')) {
            path = path.substring(7);
        }
        
        // Ensure path starts with / on Android
        if (!path.startsWith('/')) {
            path = '/' + path;
        }
        
        // Encode the path to handle spaces and special characters correctly.
        // We split/map to only encode individual segments, not the slashes.
        const segments = path.split('/').map(segment => encodeURIComponent(segment));
        return 'file://' + segments.join('/');
    }, []);

    const mergeAndSetAssets = useCallback((currentLocalAssets, finalize = false) => {
        const initialAssets = currentLocalAssets.map(a => {
            const cached = SyncService.localHashCache[a.id];
            const hash = a.hash || cached?.hash;
            // Use DB-synced uploaded flag instead of in-memory hash set lookup
            const isSynced = cached?.uploaded === true;
            return {
                ...a,
                hash: hash || a.hash,
                status: isSynced ? 'synced' : 'local'
            };
        });
        const localHashes = new Set(initialAssets.filter(a => a.hash).map(a => a.hash.toLowerCase()));
        
        // Build a Set of local timestamps (using ±2s range to solve edge-of-bucket divide issues).
        // We add both direct UTC seconds and local wall-clock interpreted as UTC seconds.
        const localDateSecSet = new Set();
        
        // Build a Set of local filenames + hour representation to allow timezone-resilient filename matching
        const localFilenameHourSet = new Set();
        
        const getNameWithoutExt = (filename) => {
            if (!filename) return '';
            const idx = filename.lastIndexOf('.');
            return idx === -1 ? filename.toLowerCase() : filename.substring(0, idx).toLowerCase();
        };

        initialAssets.forEach(a => {
            if (!a.hash) {
                const t = a.creationTime || a.modificationTime || 0;
                if (t > 0) {
                    // 1. Direct UTC seconds (±2s range)
                    const sec = Math.floor(t / 1000);
                    for (let i = -2; i <= 2; i++) {
                        localDateSecSet.add(sec + i);
                    }
                    
                    // 2. Wall-clock UTC seconds (±2s range)
                    const d = new Date(t);
                    const wallClockUtc = Date.UTC(
                        d.getFullYear(),
                        d.getMonth(),
                        d.getDate(),
                        d.getHours(),
                        d.getMinutes(),
                        d.getSeconds()
                    );
                    const wallSec = Math.floor(wallClockUtc / 1000);
                    for (let i = -2; i <= 2; i++) {
                        localDateSecSet.add(wallSec + i);
                    }

                    // 3. Filename + Hour Match (tolerating exact time offset but keeping name matching)
                    const name = getNameWithoutExt(a.filename);
                    if (name) {
                        const directHour = Math.floor(t / 3600000);
                        localFilenameHourSet.add(`${name}_${directHour}`);
                        
                        const wallHour = Math.floor(wallClockUtc / 3600000);
                        localFilenameHourSet.add(`${name}_${wallHour}`);
                    }
                }
            }
        });

        // Filter and map remote assets from the flat remoteAssetsList loaded from SQLite
        const filteredRemoteAssets = remoteAssetsListRef.current
            .filter(asset => {
                const hashLower = asset.hash ? asset.hash.toLowerCase() : '';
                if (!hashLower) return false;

                // 1. If we already know the local asset has this hash, it's synced (skip remote representation)
                if (localHashes.has(hashLower)) return false;

                // 2. Timezone-resilient duplicate heuristics (used for unhashed assets)
                const time = asset.creationTime;
                if (time > 0) {
                    const remoteSec = Math.floor(time / 1000);
                    if (localDateSecSet.has(remoteSec)) return false;

                    const remoteName = getNameWithoutExt(asset.filename);
                    if (remoteName) {
                        const remoteHour = Math.floor(time / 3600000);
                        if (
                            localFilenameHourSet.has(`${remoteName}_${remoteHour}`) ||
                            localFilenameHourSet.has(`${remoteName}_${remoteHour - 1}`) ||
                            localFilenameHourSet.has(`${remoteName}_${remoteHour + 1}`)
                        ) {
                            return false;
                        }
                    }
                }
                return true;
            })
            .map(asset => {
                const filename = asset.filename || '';
                return {
                    id: asset.id,
                    hash: asset.hash,
                    uri: MediaService.getPreviewUrl(asset.hash, asset.mediaType),
                    status: 'remote',
                    creationTime: asset.creationTime || 0,
                    mediaType: asset.mediaType || (isVideoExtension(filename) ? 'video' : 'photo'),
                    filename: filename,
                    isFavorite: asset.isFavorite,
                    localCachePath: asset.localCachePath
                };
            });
        // Fast O(N) linear merge of two pre-sorted arrays (descending)
        const combined = [];
        let i = 0, j = 0;
        while (i < initialAssets.length && j < filteredRemoteAssets.length) {
            const timeA = initialAssets[i].creationTime || initialAssets[i].modificationTime || 0;
            const timeB = filteredRemoteAssets[j].creationTime || 0;
            if (timeA >= timeB) {
                combined.push(initialAssets[i++]);
            } else {
                combined.push(filteredRemoteAssets[j++]);
            }
        }
        while (i < initialAssets.length) combined.push(initialAssets[i++]);
        while (j < filteredRemoteAssets.length) combined.push(filteredRemoteAssets[j++]);
        
        let finalCombined = combined;
        
        if (isMounted.current) {
            const newMap = new Map();
            for (const a of finalCombined) {
                if (a.id) newMap.set(a.id, a);
                if (a.hash) newMap.set(a.hash, a);
            }
            globalAssetMapRef.current = newMap;
            
            GalleryStore.setAssets(finalCombined);
            setAssets(finalCombined);
            // Always sync queue immediately so new photos start backing up on app launch
            const AutoBackupManager = require('../services/AutoBackupManager').default;
            AutoBackupManager.syncQueueWithGallery();
            MetricsTracker.end('HomeScreen_mergeAndSetAssets', `(Assets: ${finalCombined.length}, finalize: ${finalize})`);
        }
    }, []);

    const formatDateHeader = (timestamp) => {
        if (!timestamp || timestamp === 0) return 'Unknown Date';
        const date = new Date(timestamp);
        const now = new Date();
        const isToday = date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const isYesterday = date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear();

        if (isToday) return 'Today';
        if (isYesterday) return 'Yesterday';
        
        // Group everything else by Month to eliminate excessive white space from daily 1-photo rows
        if (date.getFullYear() === now.getFullYear()) {
             return date.toLocaleDateString(undefined, { month: 'long' });
        }
        return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    };

    const { timelineData, stickyHeaderIndices } = useMemo(() => {
        const data = [];
        const indices = [];
        if (!activeAssets || activeAssets.length === 0) return { timelineData: data, stickyHeaderIndices: indices };

        const isActivelySearching = isSearching && (searchTokens.length > 0 || searchQuery.trim() !== '');

        if (isActivelySearching) {
            let currentOffset = 0;

            // Build a globalIndex map once: O(N) instead of calling findIndex per asset (O(N²)).
            // With 2000 assets, findIndex caused 4M comparisons = ~9 second JS thread block.
            const globalIndexMap = new Map();
            activeAssets.forEach((asset, idx) => globalIndexMap.set(asset.id, idx));

            const pushSection = (sectionTitle, sectionAssets) => {
                if (sectionAssets.length === 0) return;

                // Push Section Header
                indices.push(data.length);
                data.push({ 
                    type: 'header', 
                    id: `header-${sectionTitle}`, 
                    title: sectionTitle, 
                    length: 48, 
                    offset: currentOffset 
                });
                currentOffset += 48;

                let currentRowItems = [];
                const pushRow = () => {
                    if (currentRowItems.length > 0) {
                        const rowId = `row-${currentRowItems.map(item => item.id).join('_')}`;
                        data.push({ type: 'row', id: rowId, items: currentRowItems, length: ITEM_SIZE, offset: currentOffset });
                        currentOffset += ITEM_SIZE;
                        currentRowItems = [];
                    }
                };

                sectionAssets.forEach((asset) => {
                    // O(1) map lookup instead of O(N) findIndex
                    currentRowItems.push({ ...asset, globalIndex: globalIndexMap.get(asset.id) ?? 0 });
                    if (currentRowItems.length === COLUMN_COUNT) {
                        pushRow();
                    }
                });
                pushRow();
            };

            pushSection('Search Results', activeAssets);

            timelineDataRef.current = data;
            stickyHeaderIndicesRef.current = indices;
            return { timelineData: data, stickyHeaderIndices: indices };
        }

        const dateCache = new Map();
        let currentHeaderKey = null;
        let currentRowItems = [];
        let currentOffset = 0;

        const pushRow = () => {
            if (currentRowItems.length > 0) {
                const rowId = `row-${currentRowItems.map(item => item.id).join('_')}`;
                data.push({ type: 'row', id: rowId, items: currentRowItems, length: ITEM_SIZE, offset: currentOffset });
                currentOffset += ITEM_SIZE;
                currentRowItems = [];
            }
        };

        const now = new Date();
        const nowD = now.getDate(), nowM = now.getMonth(), nowY = now.getFullYear();
        const yd = new Date(now); yd.setDate(nowD - 1);
        const ydD = yd.getDate(), ydM = yd.getMonth(), ydY = yd.getFullYear();
        const headerKeyCache = new Map();

        activeAssets.forEach((asset, globalIndex) => {
            const time = asset.creationTime || asset.modificationTime || 0;
            const dayInt = Math.floor(time / 86400000);

            let headerKey = headerKeyCache.get(dayInt);
            if (headerKey === undefined) {
                const d = new Date(time);
                const isToday = d.getDate() === nowD && d.getMonth() === nowM && d.getFullYear() === nowY;
                const isYesterday = !isToday && d.getDate() === ydD && d.getMonth() === ydM && d.getFullYear() === ydY;
                
                if (isToday) headerKey = 'today';
                else if (isYesterday) headerKey = 'yesterday';
                else {
                    headerKey = d.getFullYear() * 100 + (d.getMonth() + 1);
                }
                headerKeyCache.set(dayInt, headerKey);
            }

            if (headerKey !== currentHeaderKey) {
                pushRow();
                currentHeaderKey = headerKey;
                
                let headerTitle = dateCache.get(headerKey);
                if (!headerTitle) {
                    headerTitle = formatDateHeader(time);
                    dateCache.set(headerKey, headerTitle);
                }

                indices.push(data.length);
                data.push({ type: 'header', id: `header-${data.length}`, title: headerTitle, length: 48, offset: currentOffset });
                currentOffset += 48;
            }

            currentRowItems.push({ ...asset, globalIndex });
            if (currentRowItems.length === COLUMN_COUNT) {
                pushRow();
            }
        });
        pushRow();

        timelineDataRef.current = data;
        stickyHeaderIndicesRef.current = indices;

        return { timelineData: data, stickyHeaderIndices: indices };
    }, [activeAssets, isSearching, searchQuery, searchTokens]);

    const getItemLayout = useCallback((data, index) => {
        const item = data ? data[index] : null;
        if (!item) return { length: ITEM_SIZE, offset: 0, index };
        return { length: item.length, offset: item.offset, index };
    }, []);

    const handleScrub = useCallback((pageY) => {
        const currentData = timelineDataRef.current;
        if (!containerHeightRef.current || currentData.length === 0) return;
        
        let relativeY = pageY - scrubberPageYRef.current;
        if (relativeY < 0) relativeY = 0;
        if (relativeY > containerHeightRef.current) relativeY = containerHeightRef.current;
        
        const percentage = relativeY / containerHeightRef.current;
        
        let targetIndex = Math.floor(percentage * currentData.length);
        if (targetIndex >= currentData.length) targetIndex = currentData.length - 1;
        if (targetIndex < 0) targetIndex = 0;
        
        scrubThumbY.setValue(percentage * (containerHeightRef.current - 40));
        scrubTooltipY.setValue(Math.max(0, percentage * (containerHeightRef.current - 40) - 10));
        
        if (lastScrubIndexRef.current === targetIndex) return;
        lastScrubIndexRef.current = targetIndex;
        
        let text = '...';
        for (let i = targetIndex; i >= 0; i--) {
            if (currentData[i] && currentData[i].type === 'header') {
                text = currentData[i].title;
                break;
            }
        }
        if (text === '...' && currentData.length > 0) {
           for (let i = 0; i < currentData.length; i++) {
               if (currentData[i].type === 'header') { text = currentData[i].title; break; }
           }
        }
        
        if (lastScrubTextRef.current !== text) {
            lastScrubTextRef.current = text;
            try {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            } catch (e) {}
        }
        setScrubText(text);

        // Throttle gallery jumps to 50ms. 
        // This stops "Gesture Flooding" where every pixel of movement tries to jump the native list,
        // which is the cause of the multi-second UI freezes.
        const now = Date.now();
        if (now - lastJumpTimeRef.current > 50) {
            lastJumpTimeRef.current = now;
            if (listRef.current) {
                listRef.current.scrollToIndex({ index: targetIndex, animated: false });
            }
        }
    }, [scrubThumbY, scrubTooltipY]);

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onStartShouldSetPanResponderCapture: () => true,
            onMoveShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponderCapture: () => true,
            onPanResponderGrant: (evt, gestureState) => {
                setIsScrubbing(true);
                isScrubbingRef.current = true;
                handleScrub(gestureState.y0);
            },
            onPanResponderMove: (evt, gestureState) => {
                handleScrub(gestureState.moveY);
            },
            onPanResponderRelease: () => {
                setIsScrubbing(false);
                isScrubbingRef.current = false;
                
                // Snap to nearest header
                const targetIndex = lastScrubIndexRef.current;
                const currentData = timelineDataRef.current;
                if (currentData && currentData.length > 0 && targetIndex >= 0) {
                    let closestHeaderIndex = 0;
                    for (let i = targetIndex; i >= 0; i--) {
                        if (currentData[i] && currentData[i].type === 'header') {
                            closestHeaderIndex = i;
                            break;
                        }
                    }
                    if (listRef.current) {
                        listRef.current.scrollToIndex({ index: closestHeaderIndex, animated: true });
                    }
                }
            },
            onPanResponderTerminate: () => {
                setIsScrubbing(false);
                isScrubbingRef.current = false;
            }
        })
    ).current;

    useEffect(() => {
        isMounted.current = true;
        loadAndSync();

        const subscription = AppState.addEventListener('change', nextAppState => {
            if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
                if (isMounted.current) {
                    loadAndSync();
                }
            }
            appState.current = nextAppState;
        });

        // Initialize AI and GPS sync throttles to maximum performance
        global.currentAiThrottle = 100;
        global.currentGpsThrottle = 50;

        // Clear expo-image memory cache when system signals low memory
        const memoryWarning = AppState.addEventListener('memoryWarning', () => {
            console.warn('[HomeScreen] Low memory warning — clearing image memory cache');
            global.lastMemoryWarning = Date.now();
            // Back off immediately under system memory pressure
            global.currentAiThrottle = 2500;
            global.currentGpsThrottle = 2500;
            Image.clearMemoryCache?.();
        });
        
        const subDelete = DeviceEventEmitter.addListener('assetDeleted', (deletedId) => {
            setAssets(prev => prev.filter(a => a.id !== deletedId));
            setSearchResults(prev => prev.filter(a => a.id !== deletedId));
        });
        
        flushTimerRef.current = setInterval(() => {
            if (pendingAssetUpdates.current.size > 0) {
                const updates = new Map(pendingAssetUpdates.current);
                pendingAssetUpdates.current.clear();
                
                setAssets(prev => prev.map(a => updates.has(a.id) ? updates.get(a.id) : a));
                setSearchResults(prev => prev.map(a => updates.has(a.id) ? updates.get(a.id) : a));
            }
        }, 1000); // Batch asset updates to 1 FPS to prevent massive UI flashing during concurrent uploads

        const subUpdate = DeviceEventEmitter.addListener('assetUpdated', (updatedAsset) => {
            pendingAssetUpdates.current.set(updatedAsset.id, updatedAsset);
        });
        
        const subBackupState = DeviceEventEmitter.addListener('backupState', (state) => {
            setBackupState(state);
            if (state.activeUploads) {
                setActiveUploads(prev => ({ ...prev, ...state.activeUploads }));
            }
            if (state.uploadStats) {
                setUploadStats(prev => ({ ...prev, ...state.uploadStats }));
            }
        });
        const subBackupProgress = DeviceEventEmitter.addListener('backupProgress', (data) => {
            setBackupProgress(data.progress || 0);
            if (data.activeUploads) {
                setActiveUploads(prev => ({ ...prev, ...data.activeUploads }));
            }
            if (data.uploadStats) {
                setUploadStats(prev => ({ ...prev, ...data.uploadStats }));
            }
        });

        const subRemoteAssets = DeviceEventEmitter.addListener('remoteAssetsUpdated', async () => {
            if (isMounted.current) {
                console.log('[HomeScreen] remoteAssetsUpdated event received. Reloading remote assets from SQLite...');
                try {
                    const sqliteRemoteAssets = await AssetDBService.getRemoteAssets();
                    remoteAssetsListRef.current = sqliteRemoteAssets;
                    mergeAndSetAssets(localAssetsRef.current, false);
                } catch (err) {
                    console.error('[HomeScreen] Failed to reload remote assets on event:', err);
                }
            }
        });

        // Server URL changed (e.g. dual-connection failover found a reachable path) —
        // force remote-asset thumbnails to recompute their URI and retry.
        const subServerUrl = DeviceEventEmitter.addListener('onServerUrlChanged', () => {
            setServerEpoch(prev => prev + 1);
        });

        // AI processing status pill
        const subAI = DeviceEventEmitter.addListener('ai_processing_status', (status) => {
            setAiStatus(status);
            if (status?.isProcessing) {
                if (aiPillTimer.current) clearTimeout(aiPillTimer.current);
                Animated.timing(aiPillOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
            } else {
                // Fade out after 2 seconds when done
                aiPillTimer.current = setTimeout(() => {
                    Animated.timing(aiPillOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start(() => {
                        setAiStatus(null);
                    });
                }, 2000);
            }
        });

        return () => { 
            if (flushTimerRef.current) clearInterval(flushTimerRef.current);
            if (aiPillTimer.current) clearTimeout(aiPillTimer.current);
            isMounted.current = false; 
            subscription.remove();
            memoryWarning.remove();
            subDelete.remove();
            subUpdate.remove();
            subBackupState.remove();
            subBackupProgress.remove();
            subRemoteAssets.remove();
            subServerUrl.remove();
            subAI.remove();
        };
    }, [loadAndSync]);

    const assetsCountRef = useRef(0);
    useEffect(() => {
        assetsCountRef.current = assets.length;
    }, [assets]);

    useEffect(() => {
        GalleryStore.setAssets(assets);
    }, [assets]);



    const loadAndSync = useCallback(async (skipPriming = false) => {
        if (assetsCountRef.current === 0) {
            setLoading(true);
        }
        setError(null);
        try {
            if (!skipPriming) {
                // Check without triggering the OS dialog, so a first-time user sees an
                // explanation before the system prompt rather than a blind ask.
                const existing = await MediaService.getPermissionStatus();
                if (!existing.granted) {
                    setPermissionStatus(existing.canAskAgain === false ? 'denied' : 'priming');
                    setLoading(false);
                    return;
                }
            }

            const granted = await MediaService.requestPermissions();
            setPermissionStatus(granted ? 'granted' : 'denied');
            if (!granted) {
                setLoading(false);
                return;
            }

            // 1. Load the lightweight local hash cache first (extremely fast flat json)
            await SyncService.loadLocalHashCache();

            // Load local assets and remote assets concurrently.
            // Reading local metadata is very fast, and querying SQLite for remote assets is extremely fast (<50ms).
            const [cumulativeLocalAssets, sqliteRemoteAssets, sqliteOnThisDayAssets] = await Promise.all([
                MediaService.getAllAssets(null, 500, excludedAlbums),
                AssetDBService.getRemoteAssets(),
                AssetDBService.getOnThisDayAssets()
            ]);
            localAssetsRef.current = cumulativeLocalAssets;
            remoteAssetsListRef.current = sqliteRemoteAssets;

            // Only surface already-synced memories here: a local (isLocal=1) row may not
            // have its hash computed yet, which used to build a broken "/preview/null" URL
            // and render as a blank tile.
            const mappedOnThisDay = sqliteOnThisDayAssets
                .filter(asset => asset.isLocal === 0 && asset.hash)
                .map(asset => ({
                    id: asset.id,
                    hash: asset.hash,
                    uri: MediaService.getPreviewUrl(asset.hash, asset.mediaType),
                    status: 'remote',
                    creationTime: asset.createTime || 0,
                    mediaType: asset.mediaType || (isVideoExtension(asset.filename) ? 'video' : 'photo'),
                    filename: asset.filename || ''
                }));
            setOnThisDayAssets(mappedOnThisDay);
            GalleryStore.setAssets(mappedOnThisDay, 'onThisDay');

            // Insert local assets into DB so they have GPS coordinate caching for map markers
            AssetDBService.insertLocalAssets(cumulativeLocalAssets).then(() => {
                SyncService.syncLocalGPS().catch(err => {
                    console.error('[HomeScreen] Failed to sync local GPS:', err);
                });
            }).catch(err => {
                console.error('[HomeScreen] Failed to insert local assets into DB:', err);
            });

            if (!isMounted.current) return;

            // Render the gallery immediately with both local and cached remote assets.
            // The spinner is dismissed immediately! Opening screen time is under 1 second.
            mergeAndSetAssets(cumulativeLocalAssets, false);
            setLoading(false);
            setSyncing(true);
            setSyncProgress({ message: 'Refreshing...' });

            // Fire off incremental remote tree update in background.
            // This only fetches CHANGED months (comparing cached hashes vs server).
            // It will also trigger lazy-loading of the remote Merkle tree asynchronously.
            const remoteOverviewPromise = SyncService.fetchRemoteOverview().catch(err => {
                console.warn('[HomeScreen] Remote overview failed:', err.message);
            });

            // Wait for incremental remote tree update to finish
            console.log('[HomeScreen] Awaiting remoteOverviewPromise...');
            await remoteOverviewPromise;
            console.log('[HomeScreen] remoteOverviewPromise resolved.');

            if (!isMounted.current) return;

            // 4. Perform Deep Hash Crypto-Sync
            try {
                console.log('[HomeScreen] Starting SyncService.sync...');
                setSyncProgress({ message: 'Organizing photos...' });
                const diff = await SyncService.sync(cumulativeLocalAssets, (progress) => {
                    if (!isMounted.current) return;
                    setSyncProgress(progress);
                });

                if (!isMounted.current) return;

                console.log('[HomeScreen] Deep sync finished. Diff:', {
                    upload: diff?.uploadAssets?.length,
                    download: diff?.downloadAssets?.length,
                });
                
            } catch (syncErr) {
                console.error('Error during deep sync:', syncErr);
                if (isMounted.current) setError(String(syncErr.message || syncErr));
            } finally {
                if (isMounted.current) {
                    // One final explicit UI refresh to ensure any out-of-sync states are caught and to start backup queue
                    mergeAndSetAssets(cumulativeLocalAssets, true);
                    setSyncing(false);
                    setSyncProgress(null);
                    
                    // Trigger offline cache sync in background
                    OfflineCacheService.syncFavoritesFromServer().catch(e => {
                        console.error('[HomeScreen] OfflineCacheService failed:', e);
                    });

                    // Check for large backed-up files and system space
                    const checkFreeSpaceBanner = async () => {
                        try {
                            const lastDismissed = await SecureStore.getItemAsync('lastBannerDismissed');
                            if (lastDismissed) {
                                const daysSinceDismiss = (Date.now() - parseInt(lastDismissed, 10)) / (1000 * 60 * 60 * 24);
                                if (daysSinceDismiss < 7) {
                                    setFreeUpSpaceInfo({ visible: false, count: 0, loading: false });
                                    return; // within cooldown
                                }
                            }
                            
                            // Check system space (< 5GB threshold)
                            const freeSpaceBytes = await LegacyFileSystem.getFreeDiskStorageAsync();
                            const freeSpaceGB = freeSpaceBytes / (1024 * 1024 * 1024);
                            if (freeSpaceGB > 5) {
                                setFreeUpSpaceInfo({ visible: false, count: 0, loading: false });
                                return; // still has plenty of space
                            }

                            const largeFiles = await AssetDBService.getSafelyBackedUpVideos();
                            if (isMounted.current && largeFiles && largeFiles.length > 0) {
                                setFreeUpSpaceInfo({ visible: true, count: largeFiles.length, loading: false });
                            } else if (isMounted.current) {
                                setFreeUpSpaceInfo({ visible: false, count: 0, loading: false });
                            }
                        } catch (e) {
                            console.error('[HomeScreen] Error checking large files banner condition:', e);
                        }
                    };
                    checkFreeSpaceBanner();
                }
            }

        } catch (err) {
            console.error('Initial load error:', err);
            if (isMounted.current) setError(String(err.message || err));
        } finally {
            if (isMounted.current && loading) {
                 setLoading(false);
            }
        }
    }, [loading, mergeAndSetAssets]);

    const StatusIcon = memo(function StatusIcon({ item, currentAssetId, activeAssetIds = [] }) {
        if (item.id === currentAssetId || activeAssetIds.includes(item.id)) {
            return <ActivityIndicator size="small" color="#007AFF" style={styles.statusIcon} />;
        }
        switch (item.status) {
            case 'remote':
            case 'synced':
                return <Cloud size={16} color="white" style={styles.statusIcon} />;
            case 'local':
                return <UploadCloud size={14} color="rgba(255,255,255,0.7)" style={styles.statusIcon} />;
            default:
                return null;
        }
    });

    const RenderAsset = memo(function RenderAsset({ asset, globalIndex, navigation, debugMode, currentAssetId, activeAssetIds, activeLoadRef, source, serverEpoch }) {
        const loadStartTime = useRef(0);
        // Only used as fallback if local video thumbnail decoding fails (e.g. WeChat codec)
        const [useRemoteFallback, setUseRemoteFallback] = useState(false);
        // Grid rows recycle this component across different assets (stable `col-N` keys),
        // so per-asset retry state must reset whenever the underlying asset changes.
        const retryCountRef = useRef(0);
        const retryTimeoutRef = useRef(null);
        const [retryTick, setRetryTick] = useState(0);
        useEffect(() => {
            retryCountRef.current = 0;
            setRetryTick(0);
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        }, [asset.id]);
        useEffect(() => () => {
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        }, []);

        let thumbnailUri = safeUri(asset.uri, asset.mediaType);
        // For synced videos: build remote preview URL to use only on onError
        const remoteFallbackUri = (asset.status === 'synced' && asset.mediaType === 'video' && asset.hash)
            ? MediaService.getPreviewUrl(asset.hash, asset.mediaType)
            : null;

        if (asset.status === 'remote') {
            if (asset.localCachePath && asset.mediaType !== 'video') {
                thumbnailUri = asset.localCachePath;
            } else if (asset.hash) {
                // ALWAYS use /preview/ for remote assets to prevent Glide OOM on large files/videos
                thumbnailUri = MediaService.getPreviewUrl(asset.hash, asset.mediaType);
            } else {
                // No hash or local cache yet — don't hand Glide an empty/invalid source,
                // just show the placeholder tile until this asset has enough data.
                thumbnailUri = null;
            }
        } else if (remoteFallbackUri && useRemoteFallback) {
            // Local decoding failed (WeChat video etc.) — use remote preview
            thumbnailUri = remoteFallbackUri;
        }

        // Force a refetch after a retry or a server URL switch (bare URL alone won't
        // re-trigger the image loader since the string would otherwise be identical).
        if (thumbnailUri && asset.status === 'remote' && (retryTick > 0 || serverEpoch > 0)) {
            thumbnailUri += `${thumbnailUri.includes('?') ? '&' : '?'}_r=${serverEpoch}.${retryTick}`;
        }

        return (
            <TouchableOpacity
                style={styles.itemContainer}
                onPress={() => navigation.navigate('AssetDetail', { initialIndex: globalIndex, source })}
            >
                {thumbnailUri ? (
                    <Image
                        source={{ uri: thumbnailUri }}
                        style={styles.image}
                        contentFit="cover"
                        cachePolicy={GRID_IMAGE_CACHE_POLICY}
                        transition={0}
                        recyclingKey={asset.id ? String(asset.id) : null}
                        onLoadStart={() => {
                            if (asset.status === 'remote') {
                                loadStartTime.current = Date.now();
                                activeLoadRef.current++;
                                ThumbnailLoadTracker.increment();
                            }
                        }}
                        onLoad={() => {
                            if (asset.status === 'remote' && loadStartTime.current > 0) {
                                activeLoadRef.current--;
                                ThumbnailLoadTracker.decrement();
                                const diff = Date.now() - loadStartTime.current;
                                if (debugMode) console.log(`[Metrics] Remote asset ${asset.hash.substring(0, 8)} loaded in ${diff}ms (Concurrent: ${activeLoadRef.current})`);
                                loadStartTime.current = 0;
                            }
                        }}
                        onError={(e) => {
                                if (asset.status === 'remote') { activeLoadRef.current--; ThumbnailLoadTracker.decrement(); }
                                if (remoteFallbackUri && !useRemoteFallback) {
                                    // Local video thumbnail failed (e.g. WeChat codec) — fall back to remote preview
                                    setUseRemoteFallback(true);
                                    return;
                                }
                                // Remote preview fetch failed (e.g. transient server/connection
                                // blip) — retry a few times with backoff instead of leaving a
                                // permanently blank tile.
                                if (asset.status === 'remote' && retryCountRef.current < 3) {
                                    const attempt = retryCountRef.current + 1;
                                    retryCountRef.current = attempt;
                                    const backoffMs = [1000, 3000, 6000][attempt - 1];
                                    retryTimeoutRef.current = setTimeout(() => {
                                        setRetryTick(t => t + 1);
                                    }, backoffMs);
                                }
                                if (debugMode) {
                                    const diff = loadStartTime.current > 0 ? Date.now() - loadStartTime.current : 'N/A';
                                    console.log(`[Metrics] Remote asset ${asset.id} error after ${diff}ms (Concurrent: ${activeLoadRef.current}):`, e.error || e);
                                }
                        }}
                    />
                ) : (
                    // No usable URI yet (e.g. remote asset whose hash hasn't synced down) —
                    // show the placeholder tile instead of handing Glide an empty source.
                    <View style={styles.image} />
                )}
                <StatusIcon item={asset} currentAssetId={currentAssetId} activeAssetIds={activeAssetIds} />
                {isLivePhoto(asset, SyncService.remoteTree) ? (
                    <View style={styles.livePhotoBadge}>
                        <LivePhotoIcon size={12} color="#fff" />
                    </View>
                ) : null}
                {asset.isFavorite ? (
                    <View style={{ position: 'absolute', bottom: 5, right: 5, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 12, padding: 4 }}>
                        <Heart color="#ef4444" fill="#ef4444" size={14} />
                    </View>
                ) : null}
                {asset.isOcrMatch ? (
                    <View style={styles.ocrBadge}>
                        <ScanText color="#fff" size={10} style={{ marginRight: 2 }} />
                        <Text style={styles.ocrBadgeText}>Text Match</Text>
                    </View>
                ) : null}
                {asset.mediaType === 'video' ? (
                    <View style={[styles.imageOverlay, styles.videoOverlay]}>
                        <PlayCircle color="#fff" size={32} />
                    </View>
                ) : null}
                {asset.status === 'remote' ? (
                    <View style={[styles.imageOverlay, { backgroundColor: 'rgba(0,0,0,0.1)' }]} />
                ) : null}
                {asset.score !== undefined ? (
                    <View style={styles.scoreBadge}>
                        <Text style={styles.scoreText}>
                            {asset.isPHash 
                                ? `${Math.round(asset.score * 100)}% Match` 
                                : `${Math.min(99, Math.max(50, Math.round(50 + (asset.score - 0.18) * 250)))}% Match`}
                        </Text>
                    </View>
                ) : null}
                {debugMode ? (
                    <View style={styles.debugOverlay}>
                        <Text style={styles.debugText}>{asset.status[0].toUpperCase()}</Text>
                        <Text style={styles.debugText}>
                          {asset.hash ? asset.hash.substring(0, 6) : 'hash?'} 
                        </Text>
                    </View>
                ) : null}
            </TouchableOpacity>
        );
    }, (prevProps, nextProps) => {
        if (
            prevProps.asset.id !== nextProps.asset.id || 
            prevProps.asset.status !== nextProps.asset.status ||
            prevProps.asset.hash !== nextProps.asset.hash ||
            prevProps.asset.uri !== nextProps.asset.uri ||
            prevProps.asset.score !== nextProps.asset.score ||
            prevProps.asset.isPHash !== nextProps.asset.isPHash ||
            prevProps.source !== nextProps.source
        ) return false;
        if (prevProps.debugMode !== nextProps.debugMode) return false;
        if (prevProps.serverEpoch !== nextProps.serverEpoch) return false;
        if (prevProps.currentAssetId !== nextProps.currentAssetId && (prevProps.asset.id === prevProps.currentAssetId || prevProps.asset.id === nextProps.currentAssetId)) return false;
        
        const prevActive = prevProps.activeAssetIds || [];
        const nextActive = nextProps.activeAssetIds || [];
        const wasActive = prevActive.includes(prevProps.asset.id);
        const isActive = nextActive.includes(nextProps.asset.id);
        if (wasActive !== isActive) return false;

        return true;
    });

    const TimelineRow = memo(function TimelineRow({ item, navigation, debugMode, currentAssetId, activeAssetIds, activeLoadCountRef, source, serverEpoch }) { return (
        <View style={styles.row}>
            {item.items.map((asset, index) => (
                <RenderAsset
                    key={`col-${index}`}
                    asset={asset}
                    globalIndex={asset.globalIndex}
                    navigation={navigation}
                    debugMode={debugMode}
                    currentAssetId={currentAssetId}
                    activeAssetIds={activeAssetIds}
                    activeLoadRef={activeLoadCountRef}
                    source={source}
                    serverEpoch={serverEpoch}
                />
            ))}
            {Array.from({ length: COLUMN_COUNT - item.items.length }).map((_, i) => (
                <View key={`empty-${i}`} style={styles.itemContainer} />
            ))}
        </View>
    ); }, (prevProps, nextProps) => {
        if (prevProps.debugMode !== nextProps.debugMode) return false;
        if (prevProps.source !== nextProps.source) return false;
        if (prevProps.serverEpoch !== nextProps.serverEpoch) return false;

        const prevItems = prevProps.item.items;
        const nextItems = nextProps.item.items;

        if (prevItems.length !== nextItems.length) return false;
        for (let i = 0; i < prevItems.length; i++) {
            if (prevItems[i].id !== nextItems[i].id || 
                prevItems[i].status !== nextItems[i].status ||
                prevItems[i].hash !== nextItems[i].hash ||
                prevItems[i].uri !== nextItems[i].uri ||
                prevItems[i].score !== nextItems[i].score ||
                prevItems[i].isPHash !== nextItems[i].isPHash) {
                return false;
            }
        }

        if (prevProps.currentAssetId !== nextProps.currentAssetId) {
            const hasOldCurrent = prevItems.some(asset => asset.id === prevProps.currentAssetId);
            const hasNewCurrent = nextItems.some(asset => asset.id === nextProps.currentAssetId);
            if (hasOldCurrent || hasNewCurrent) return false;
        }

        const prevActive = prevProps.activeAssetIds || [];
        const nextActive = nextProps.activeAssetIds || [];
        for (const asset of nextItems) {
            const wasActive = prevActive.includes(asset.id);
            const isActive = nextActive.includes(asset.id);
            if (wasActive !== isActive) return false;
        }

        return true;
    });

    const renderItem = useCallback(({ item, extraData }) => {
        if (item.type === 'header') {
            return (
                <View style={styles.dateHeaderContainer}>
                    <Text style={styles.dateHeaderText}>{item.title}</Text>
                </View>
            );
        }
        return (
            <TimelineRow 
                item={item}
                navigation={navigation}
                debugMode={extraData?.debugMode || false}
                currentAssetId={extraData?.currentAssetId || null}
                activeAssetIds={extraData?.activeAssetIds || []}
                isScrubbing={extraData?.isScrubbing || false}
                activeLoadCountRef={globalActiveLoadCount}
                source={extraData?.source || 'gallery'}
                serverEpoch={extraData?.serverEpoch || 0}
            />
        );
    }, [navigation]);

    const smoothOverallProgress = useMemo(() => {
        if (!backupState || backupState.totalCount === 0) return 1;
        
        const completed = backupState.completedCount || 0;
        let activeFractionSum = 0;
        
        if (activeUploads) {
            for (const key in activeUploads) {
                activeFractionSum += (activeUploads[key] || 0);
            }
        }
        
        const totalProgress = (completed + activeFractionSum) / backupState.totalCount;
        return Math.min(1, Math.max(0, totalProgress));
    }, [backupState.completedCount, backupState.totalCount, activeUploads]);

    // Distinguish "can't reach the home server" from real errors, so a Wi-Fi/NAS
    // hiccup reads as reassuring status rather than an alarming failure.
    const isOfflineError = useMemo(() => {
        if (!error) return false;
        return /network error|timeout|econnrefused|econnaborted|enotfound|failed to fetch|net::err|unable to resolve host/i.test(error);
    }, [error]);

    const flashListExtraData = useMemo(() => ({
        isScrubbing,
        currentAssetId: backupState.currentAssetId,
        activeAssetIds: backupState.activeAssetIds,
        debugMode,
        serverEpoch,
        source: isSearching && (searchTokens.length > 0 || searchQuery.trim() !== '') ? 'search' : 'gallery'
    }), [isScrubbing, backupState.currentAssetId, backupState.activeAssetIds, debugMode, serverEpoch, isSearching, searchQuery, searchTokens]);

    const renderOnThisDay = () => {
        if (!onThisDayAssets || onThisDayAssets.length === 0 || isSearching) return null;

        return (
            <View style={styles.onThisDayContainer}>
                <View style={styles.onThisDayHeaderRow}>
                    <Text style={styles.onThisDayTitle}>On This Day</Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.onThisDayScrollContent}>
                    {onThisDayAssets.map((asset, index) => {
                        const date = new Date(asset.creationTime);
                        const yearsAgo = new Date().getFullYear() - date.getFullYear();
                        return (
                            <TouchableOpacity 
                                key={asset.id} 
                                style={styles.onThisDayCard}
                                onPress={() => navigation.navigate('AssetDetail', { initialIndex: index, source: 'onThisDay' })}
                            >
                                <Image 
                                    source={{ uri: safeUri(asset.uri, asset.mediaType) }} 
                                    style={styles.onThisDayImage} 
                                />
                                <View style={styles.onThisDayOverlay}>
                                    <Text style={styles.onThisDayText}>{yearsAgo} {yearsAgo === 1 ? 'year' : 'years'} ago</Text>
                                </View>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>
        );
    };

    const removeToken = (tokenId) => {
        setSearchTokens(prev => prev.filter(t => t.id !== tokenId));
    };

    const renderSuggestions = () => {
        const locations = suggestions.filter(s => s.type === 'location');
        const times = suggestions.filter(s => s.type === 'time');
        const semantics = suggestions.filter(s => s.type === 'semantic');

        const selectSuggestion = (item) => {
            hideSuggestionsUntilFocusRef.current = true;
            Keyboard.dismiss();

            if (!searchTokens.some(t => t.type === item.type && t.value === item.value)) {
                setSearchTokens(prev => [...prev, {
                    id: item.id,
                    type: item.type,
                    value: item.value,
                    extra: item.extra
                }]);
            }
            
            const q = searchQuery.trim().toLowerCase();
            const pinyinMatch = pinyin(q, { toneType: 'none', type: 'array' }).join('');

            if (q === '' || 
                item.label.toLowerCase().includes(q) || 
                item.value.toLowerCase().includes(q) ||
                item.label.toLowerCase().includes(pinyinMatch) ||
                item.value.toLowerCase().includes(pinyinMatch)) {
                setSearchQuery('');
            }
            
            setSuggestionTrigger(prev => prev + 1);
        };

        return (
            <View style={styles.suggestionsContent}>
                {locations.length > 0 && (
                    <View style={styles.suggestionSection}>
                        <Text style={styles.suggestionSectionHeader}>Locations</Text>
                        {locations.map((item) => (
                            <TouchableOpacity key={item.id} style={styles.suggestionItem} onPress={() => selectSuggestion(item)}>
                                <MapPin size={16} color="#007AFF" style={styles.suggestionIcon} />
                                <Text style={styles.suggestionItemText}>{item.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {times.length > 0 && (
                    <View style={styles.suggestionSection}>
                        <Text style={styles.suggestionSectionHeader}>Time</Text>
                        {times.map((item) => (
                            <TouchableOpacity key={item.id} style={styles.suggestionItem} onPress={() => selectSuggestion(item)}>
                                <Calendar size={16} color="#007AFF" style={styles.suggestionIcon} />
                                <Text style={styles.suggestionItemText}>{item.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {semantics.length > 0 && (
                    <View style={styles.suggestionSection}>
                        <Text style={styles.suggestionSectionHeader}>Scenes & Objects</Text>
                        {semantics.map((item) => (
                            <TouchableOpacity key={item.id} style={styles.suggestionItem} onPress={() => selectSuggestion(item)}>
                                <Search size={16} color="#007AFF" style={styles.suggestionIcon} />
                                <Text style={styles.suggestionItemText}>{item.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
        );
    };

    const handleKeyPress = ({ nativeEvent }) => {
        if (nativeEvent.key === 'Backspace' && searchQuery === '' && searchTokens.length > 0) {
            setSearchTokens(prev => prev.slice(0, -1));
        }
    };

    return (
        <View style={styles.container}>
            {debugMode && debugLogs.length > 0 && (
                <View style={styles.debugLogOverlay} pointerEvents="none">
                    <ScrollView showsVerticalScrollIndicator={false}>
                        {debugLogs.map((log, i) => (
                            <Text key={i} style={styles.debugLogText}>{log}</Text>
                        ))}
                    </ScrollView>
                </View>
            )}
            {isSearching ? (
                <View 
                    style={{ backgroundColor: '#fff', zIndex: 10 }}
                    onLayout={(e) => {
                        const { height } = e.nativeEvent.layout;
                        if (height > 0) setHeaderHeight(height);
                    }}
                >
                    <View style={styles.searchHeader}>
                        <View style={styles.searchBarContainer}>
                            <Search size={18} color="#999" style={styles.searchIcon} />
                            {searchTokens.length > 0 && (
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    keyboardShouldPersistTaps="handled"
                                    style={styles.tokensScrollView}
                                    contentContainerStyle={styles.tokensScrollContent}
                                >
                                    {searchTokens.map(token => {
                                        let prefix = '';
                                        if (token.type === 'location') prefix = '📍 ';
                                        else if (token.type === 'time') prefix = '📅 ';
                                        else if (token.type === 'semantic') prefix = '🔍 ';
                                        
                                        return (
                                            <TouchableOpacity 
                                                key={token.id} 
                                                style={styles.tokenChip} 
                                                onPress={() => removeToken(token.id)}
                                                activeOpacity={0.7}
                                            >
                                                <Text style={styles.tokenChipText}>{prefix}{token.value}</Text>
                                                <View style={styles.tokenChipClose}>
                                                    <X size={10} color="#007AFF" />
                                                </View>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            )}
                            <TextInput
                                style={styles.searchInput}
                                placeholder={searchTokens.length > 0 ? "" : "Search (e.g. cat 2023)..."}
                                placeholderTextColor="#8E8E93"
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                autoFocus
                                clearButtonMode="while-editing"
                                returnKeyType="search"
                                onKeyPress={handleKeyPress}
                                onSubmitEditing={() => setSuggestions([])}
                                onFocus={() => {
                                    hideSuggestionsUntilFocusRef.current = false;
                                    setSuggestionTrigger(prev => prev + 1);
                                }}
                                onTouchStart={() => {
                                    hideSuggestionsUntilFocusRef.current = false;
                                    setSuggestionTrigger(prev => prev + 1);
                                }}
                            />
                            {isSearchLoading && timelineData.length > 0 ? (
                                <ActivityIndicator size="small" color="#007AFF" style={styles.searchLoadingIndicator} />
                            ) : null}
                        </View>
                        <TouchableOpacity 
                            onPress={() => {
                                Keyboard.dismiss();
                                setIsSearching(false);
                                setSearchQuery('');
                                setSearchTokens([]);
                                setSearchResults([]);
                                setSuggestions([]);
                            }} 
                            style={styles.cancelButton}
                        >
                            <Text style={styles.cancelButtonText}>Cancel</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Tags Layout: Two Rows for Better UX */}
                    <View style={styles.tagsWrapper}>
                        {/* Time Tags Row */}
                        <ScrollView 
                            horizontal 
                            showsHorizontalScrollIndicator={false} 
                            keyboardShouldPersistTaps="handled"
                            style={styles.tagsContainer}
                            contentContainerStyle={styles.tagsContent}
                        >
                            {TIME_TAGS.map((tag, idx) => {
                                const isActive = searchTokens.some(t => t.type === tag.type && t.value === tag.query);
                                return (
                                    <TouchableOpacity 
                                        key={`time-${idx}`} 
                                        style={[styles.tagButton, isActive && styles.tagButtonActive]}
                                        onPress={() => handleTagPress(tag)}
                                    >
                                        <Text style={[styles.tagText, isActive && styles.tagTextActive]}>
                                            {tag.label}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>

                        {/* Semantic Tags Row */}
                        <ScrollView 
                            horizontal 
                            showsHorizontalScrollIndicator={false} 
                            keyboardShouldPersistTaps="handled"
                            style={[styles.tagsContainer, { marginTop: 8 }]}
                            contentContainerStyle={styles.tagsContent}
                        >
                            {SMART_TAGS.map((tag, idx) => {
                                const semanticTag = {...tag, type: 'semantic'};
                                const isActive = searchTokens.some(t => t.type === semanticTag.type && t.value === semanticTag.query);
                                return (
                                    <TouchableOpacity 
                                        key={`semantic-${idx}`} 
                                        style={[styles.tagButton, isActive && styles.tagButtonActive]}
                                        onPress={() => handleTagPress(semanticTag)}
                                    >
                                        <Text style={[styles.tagText, isActive && styles.tagTextActive]}>
                                            {semanticTag.label}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </View>
                </View>
            ) : (
                <View style={styles.header}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>Lomorage</Text>
                        <Text style={styles.subtitle}>
                            {`${assets.length} items${syncing ? ` • ${syncProgress?.message || 'Loading...'}` : isOfflineError ? ' • Server offline' : error ? ' • Error' : ''}`}
                        </Text>
                        {syncing && syncProgress?.total > 0 && syncProgress?.current !== undefined ? (
                            <Text style={styles.progressText}>
                                 {`(${syncProgress.current}/${syncProgress.total})`}
                            </Text>
                        ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {syncing ? <ActivityIndicator size="small" color="#007AFF" style={{ marginRight: 10 }} /> : null}
                        
                        {(backupState.totalCount > 0 || backupState.isBackingUp) && (
                            <TouchableOpacity 
                                onPress={() => setBottomSheetVisible(true)} 
                                style={{ marginRight: 15, width: 36, height: 36, justifyContent: 'center', alignItems: 'center' }}
                            >
                                <Cloud size={24} color={backupState.isPaused ? '#999' : '#007AFF'} />
                                {backupState.pendingCount > 0 ? (
                                    <View style={{ width: 24, height: 4, backgroundColor: '#E5E5EA', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                                        <View style={{ height: '100%', backgroundColor: backupState.isPaused ? '#999' : '#007AFF', width: `${smoothOverallProgress * 100}%` }} />
                                    </View>
                                ) : (
                                    <View style={{ position: 'absolute', right: -2, bottom: -2, backgroundColor: '#fff', borderRadius: 8 }}>
                                        <CheckCircle size={14} color="#34C759" />
                                    </View>
                                )}
                            </TouchableOpacity>
                        )}

                        <TouchableOpacity onPress={() => setIsSearching(true)} style={{ marginRight: 15, padding: 4 }}>
                            <Search size={24} color="#333" />
                        </TouchableOpacity>

                        <TouchableOpacity onPress={() => navigation.navigate('PhotoMap')} style={{ marginRight: 15, padding: 4 }}>
                            <MapPin size={24} color="#333" />
                        </TouchableOpacity>

                        <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={styles.settingsButton}>
                            <SettingsIcon size={24} color="#333" />
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* REMOVED BIG BANNER FOR OPTION A */}

            {(permissionStatus === 'priming' || permissionStatus === 'denied') ? (
                <View style={styles.permissionScreen}>
                    <View style={[styles.permissionIconCircle, permissionStatus === 'denied' && styles.permissionIconCircleDenied]}>
                        <ImagesIcon size={36} color={permissionStatus === 'denied' ? '#B45309' : '#007AFF'} />
                    </View>
                    {permissionStatus === 'priming' ? (
                        <>
                            <Text style={styles.permissionTitle}>Access your photos</Text>
                            <Text style={styles.permissionText}>
                                Lomorage needs to see your photo library to back it up to your own server. Nothing uploads until you allow it, and it never leaves your server.
                            </Text>
                            <TouchableOpacity style={styles.button} onPress={() => loadAndSync(true)}>
                                <Text style={styles.buttonText}>Continue</Text>
                            </TouchableOpacity>
                        </>
                    ) : (
                        <>
                            <Text style={styles.permissionTitle}>Photo access is off</Text>
                            <Text style={styles.permissionText}>
                                Lomorage can&apos;t back up your photos without access to your library. Turn it on in Settings, then come back here.
                            </Text>
                            <TouchableOpacity style={styles.button} onPress={() => Linking.openSettings()}>
                                <Text style={styles.buttonText}>Open Settings</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>
            ) : (
            <>
            {error ? (
                isOfflineError ? (
                    <View style={styles.offlineBanner}>
                        <WifiOff size={16} color="#5B7290" />
                        <View style={{ flex: 1, marginLeft: 10 }}>
                            <Text style={styles.offlineTitle}>Can&apos;t reach your server</Text>
                            <Text style={styles.offlineSubtext}>Your local photos are safe on this phone — we&apos;ll keep syncing automatically once it&apos;s back.</Text>
                        </View>
                        <TouchableOpacity onPress={() => loadAndSync()} style={styles.offlineRetryButton}>
                            <Text style={styles.offlineRetryText}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <View style={styles.errorBanner}>
                        <Text style={styles.errorText} numberOfLines={1}>{error}</Text>
                        <TouchableOpacity onPress={() => loadAndSync()} style={styles.retryButton}>
                            <Text style={styles.retryText}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                )
            ) : null}

            {(loading && assets.length === 0) ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="large" color="#007AFF" />
                    <Text style={styles.loadingText}>Loading your gallery...</Text>
                </View>
            ) : (
                <View 
                    style={{ flex: 1 }}
                    ref={containerRef}
                    onLayout={() => {
                        containerRef.current?.measureInWindow((x, y, width, height) => {
                            scrubberPageYRef.current = y;
                            containerHeightRef.current = height;
                        });
                    }}
                >
                    {freeUpSpaceInfo.visible && !isSearching && (
                        <SwipeableBanner 
                            info={freeUpSpaceInfo} 
                            styles={styles} 
                            onPress={() => navigation.navigate('FreeUpSpace')} 
                            onDismiss={async () => {
                                setFreeUpSpaceInfo(prev => ({ ...prev, visible: false }));
                                try {
                                    await SecureStore.setItemAsync('lastBannerDismissed', Date.now().toString());
                                } catch (e) {
                                    console.error('[HomeScreen] Error saving dismiss state:', e);
                                }
                            }}
                        />
                    )}
                    <FlashList
                        ref={listRef}
                        data={timelineData}
                        extraData={flashListExtraData}
                        renderItem={renderItem}
                        ListHeaderComponent={renderOnThisDay()}
                        keyExtractor={item => item.id}
                        stickyHeaderIndices={stickyHeaderIndices}
                        getItemType={(item) => item.type}
                        estimatedItemSize={ITEM_SIZE}
                        drawDistance={ITEM_SIZE * 6}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={(e) => {
                            if (isScrubbingRef.current || !containerHeightRef.current) return;
                            const { y } = e.nativeEvent.contentOffset;
                            const max = e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height;
                            if (max > 0) {
                                const p = Math.max(0, Math.min(1, y / max));
                                scrubThumbY.setValue(p * (containerHeightRef.current - 40));
                            }
                        }}
                        refreshControl={
                            <RefreshControl refreshing={loading} onRefresh={loadAndSync} />
                        }
                        ListEmptyComponent={
                            <View style={styles.centered}>
                                {isSearchLoading ? (
                                    <View style={{ alignItems: 'center' }}>
                                        <ActivityIndicator size="small" color="#007AFF" style={{ marginBottom: 8 }} />
                                        <Text style={{ color: '#8e8e93', fontSize: 14 }}>Searching...</Text>
                                    </View>
                                ) : (
                                    <Text style={{ color: '#8e8e93', fontSize: 15 }}>No photos found.</Text>
                                )}
                            </View>
                        }
                    />

                    {timelineData.length > 30 && (
                        <View style={[styles.scrubberContainer, isScrubbing && styles.scrubberContainerActive]} {...panResponder.panHandlers}>
                            <View style={styles.scrubberTrack} />
                            <Animated.View style={[styles.scrubberThumb, { transform: [{ translateY: scrubThumbY }] }]} />
                        </View>
                    )}

                    {isScrubbing && (
                        <Animated.View style={[styles.scrubberTooltip, { transform: [{ translateY: scrubTooltipY }] }]}>
                            <Text style={styles.scrubberTooltipText}>{scrubText}</Text>
                        </Animated.View>
                    )}
                </View>
            )}
            </>
            )}

            {isSearching && suggestions.length > 0 && (
                <View style={[styles.suggestionsDropdown, { top: headerHeight }]}>
                    <ScrollView keyboardShouldPersistTaps="handled">
                        {renderSuggestions()}
                    </ScrollView>
                </View>
            )}

            <Modal visible={isBottomSheetVisible} transparent animationType="slide" onRequestClose={() => setBottomSheetVisible(false)}>
                <View style={styles.bottomSheetOverlay}>
                    <TouchableOpacity style={styles.bottomSheetDismissArea} onPress={() => setBottomSheetVisible(false)} />
                    <View style={styles.bottomSheetContainer}>
                        <View style={styles.bottomSheetHeaderModal}>
                            <Text style={styles.bottomSheetTitle}>Backup Status</Text>
                            <TouchableOpacity onPress={() => setBottomSheetVisible(false)} style={{ padding: 4 }}>
                                <X size={24} color="#333" />
                            </TouchableOpacity>
                        </View>
                        
                        <View style={styles.bottomSheetSummary}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.bottomSheetSummaryText}>
                                    {backupState.isPaused 
                                        ? `Paused (${backupState.pendingCount} left)` 
                                        : backupState.pendingCount > 0 
                                            ? (backupState.totalCount > 0
                                                ? `Backing up... ${backupState.totalCount - backupState.pendingCount}/${backupState.totalCount} (${Math.round(smoothOverallProgress * 100)}%)`
                                                : `Backing up... ${Math.round(smoothOverallProgress * 100)}%`)
                                            : 'Backup Complete!'}
                                </Text>
                                {backupState.isPaused && (backupState.retryMessage || backupState.pauseReason) && (
                                    <Text style={{ fontSize: 13, color: '#FF3B30', marginTop: 4 }}>
                                        {backupState.retryMessage || backupState.pauseReason}
                                    </Text>
                                )}
                            </View>
                            {backupState.pendingCount > 0 && (
                                backupState.isPaused ? (
                                    <TouchableOpacity onPress={() => AutoBackupManager.resume()} style={styles.playPauseBtn}>
                                        <PlayCircle size={28} color="#007AFF" />
                                    </TouchableOpacity>
                                ) : (
                                    <TouchableOpacity onPress={() => AutoBackupManager.pause()} style={styles.playPauseBtn}>
                                        <PauseCircle size={28} color="#007AFF" />
                                    </TouchableOpacity>
                                )
                            )}
                        </View>

                        <Animated.ScrollView style={{ maxHeight: 350, paddingHorizontal: 20 }}>
                            {backupState.activeAssetIds && backupState.activeAssetIds.map(assetId => {
                                const asset = assets.find(a => a.id === assetId);
                                if (!asset) return null;
                                const prog = activeUploads[assetId] || 0;
                                const stats = uploadStats[assetId];
                                const sizeStr = stats && stats.totalBytes ? formatBytes(stats.totalBytes) : '';
                                const speedStr = stats && stats.speed ? formatSpeed(stats.speed) : '';
                                const statsText = [sizeStr, speedStr].filter(Boolean).join(' • ');
                                return (
                                    <View key={asset.id} style={styles.activeUploadRow}>
                                        <Image source={{ uri: safeUri(asset.uri, asset.mediaType) }} style={styles.activeUploadThumb} cachePolicy={GRID_IMAGE_CACHE_POLICY} />
                                        <View style={{ flex: 1, marginLeft: 12 }}>
                                            <Text style={styles.activeUploadName} numberOfLines={1}>{asset.filename || asset.id}</Text>
                                            {statsText ? (
                                                <Text style={styles.activeUploadStatsText} numberOfLines={1}>{statsText}</Text>
                                            ) : null}
                                            <View style={styles.progressBarBgSmall}>
                                                <View style={[styles.progressBarFillSmall, { width: `${prog * 100}%` }]} />
                                            </View>
                                        </View>
                                        <Text style={styles.activeUploadProgText}>{Math.round(prog * 100)}%</Text>
                                    </View>
                                );
                            })}
                            {(!backupState.activeAssetIds || backupState.activeAssetIds.length === 0) && !backupState.isPaused && backupState.pendingCount > 0 && (
                                <Text style={styles.emptyStateText}>Preparing uploads...</Text>
                            )}
                            {backupState.totalCount > 0 && backupState.pendingCount === 0 && (
                                <Text style={styles.emptyStateText}>All items are safely backed up to Lomorage.</Text>
                            )}
                        </Animated.ScrollView>
                    </View>
                </View>
            </Modal>

            {/* AI Processing Pill — Google Photos style, non-intrusive */}
            {aiStatus && (
                <Animated.View style={[styles.aiPill, { opacity: aiPillOpacity }]} pointerEvents="none">
                    {aiStatus.isProcessing ? (
                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                    ) : (
                        <Text style={{ fontSize: 14, marginRight: 6 }}>✓</Text>
                    )}
                    <Text style={styles.aiPillText} numberOfLines={1}>
                        {aiStatus.isProcessing && aiStatus.total > 0
                            ? (aiStatus.message || `Analyzing photos ${aiStatus.current}/${aiStatus.total}`)
                            : aiStatus.isProcessing
                            ? (aiStatus.message || 'Analyzing photos...')
                            : 'Analysis complete'}
                    </Text>
                </Animated.View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    debugLogOverlay: {
        position: 'absolute',
        top: 100,
        left: 10,
        right: 10,
        height: 250,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        borderRadius: 8,
        padding: 10,
        zIndex: 9999,
    },
    debugLogText: {
        color: '#00FF00',
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 10,
        marginBottom: 2,
    },
    smartBannerContainer: {
        position: 'relative',
        marginHorizontal: 15,
        marginTop: 10,
        marginBottom: 5,
    },
    smartBanner: {
        backgroundColor: '#F2F2F7',
        padding: 12,
        paddingRight: 32,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    smartBannerContent: {
        flex: 1,
    },
    smartBannerTitle: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1a1a1a',
        marginBottom: 2,
    },
    smartBannerText: {
        fontSize: 13,
        color: '#666',
        paddingRight: 8,
    },
    smartBannerButton: {
        backgroundColor: '#007AFF',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        marginLeft: 8,
    },
    smartBannerButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
    },
    row: {
        flexDirection: 'row',
        width: '100%',
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 15,
        paddingBottom: 15,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 28,
        fontWeight: '800',
        color: '#1a1a1a',
        letterSpacing: -0.5,
    },
    subtitle: {
        fontSize: 14,
        color: '#666',
        marginTop: 2,
    },
    onThisDayContainer: {
        marginBottom: 20,
        marginTop: 10,
    },
    onThisDayHeaderRow: {
        paddingHorizontal: 16,
        marginBottom: 10,
    },
    onThisDayTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#1a1a1a',
    },
    onThisDayScrollContent: {
        paddingHorizontal: 16,
    },
    onThisDayCard: {
        width: 120,
        height: 160,
        marginRight: 10,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#f0f0f0',
    },
    onThisDayImage: {
        width: '100%',
        height: '100%',
        resizeMode: 'cover',
    },
    onThisDayOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: 8,
        paddingTop: 24, // Gradient effect space
        backgroundColor: 'rgba(0,0,0,0.3)', // Simple dark overlay instead of complex gradient
    },
    onThisDayText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    aiPill: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(30, 30, 30, 0.82)',
        paddingHorizontal: 16,
        paddingVertical: 9,
        borderRadius: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 6,
        maxWidth: '92%',
    },
    aiPillText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '500',
        letterSpacing: 0.1,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFEBEE',
        padding: 10,
        marginHorizontal: 15,
        borderRadius: 8,
        marginBottom: 10,
    },
    errorText: {
        flex: 1,
        color: '#D32F2F',
        fontSize: 14,
    },
    retryButton: {
        backgroundColor: '#D32F2F',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 4,
        marginLeft: 10,
    },
    retryText: {
        color: 'white',
        fontSize: 12,
        fontWeight: 'bold',
    },
    permissionScreen: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingBottom: 80,
    },
    permissionIconCircle: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: '#F0F7FF',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
    },
    permissionIconCircleDenied: {
        backgroundColor: '#FEF3E2',
    },
    permissionTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#1A202C',
        marginBottom: 10,
        textAlign: 'center',
    },
    permissionText: {
        fontSize: 15,
        lineHeight: 21,
        color: '#4A5568',
        textAlign: 'center',
        marginBottom: 24,
    },
    button: {
        backgroundColor: '#007AFF',
        height: 52,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    offlineBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#EAF1FB',
        borderWidth: 1,
        borderColor: '#D3E3F5',
        padding: 12,
        marginHorizontal: 15,
        borderRadius: 8,
        marginBottom: 10,
    },
    offlineTitle: {
        color: '#2A3B4D',
        fontSize: 13,
        fontWeight: '600',
    },
    offlineSubtext: {
        color: '#5B7290',
        fontSize: 12,
        marginTop: 2,
    },
    offlineRetryButton: {
        borderWidth: 1,
        borderColor: '#5B7290',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 4,
        marginLeft: 10,
    },
    offlineRetryText: {
        color: '#5B7290',
        fontSize: 12,
        fontWeight: 'bold',
    },
    progressText: {
        fontSize: 12,
        color: '#999',
        marginTop: 2,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20
    },
    loadingText: {
        marginTop: 12,
        color: '#666',
    },
    itemContainer: {
        flex: 1,
        aspectRatio: 1,
        padding: 1,
        position: 'relative',
    },
    image: {
        flex: 1,
        backgroundColor: '#f5f5f5',
    },
    imageOverlay: {
        ...StyleSheet.absoluteFillObject,
    },
    videoOverlay: {
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.2)',
    },
    statusIcon: {
        position: 'absolute',
        bottom: 6,
        right: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.5,
        shadowRadius: 2,
        elevation: 3,
    },
    livePhotoBadge: {
        position: 'absolute',
        top: 6,
        left: 6,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        padding: 5,
        borderRadius: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.4,
        shadowRadius: 1.5,
        elevation: 3,
    },
    debugOverlay: {
        position: 'absolute',
        top: 2,
        left: 2,
        backgroundColor: 'rgba(0,0,0,0.6)',
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 4,
    },
    debugText: {
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: 9,
    },
    dateHeaderContainer: {
        width: '100%',
        backgroundColor: '#fff',
        paddingHorizontal: 15,
        height: 48,
        justifyContent: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#ebebeb',
    },
    dateHeaderText: {
        fontSize: 16,
        fontWeight: '700',
        color: '#1a1a1a',
    },
    scrubberContainer: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 30,
        zIndex: 10,
    },
    scrubberTrack: {
        position: 'absolute',
        right: 6,
        top: 0,
        bottom: 0,
        width: 2,
        backgroundColor: '#E5E5EA',
    },
    scrubberThumb: {
        position: 'absolute',
        right: 4,
        top: 0,
        width: 6,
        height: 40,
        backgroundColor: '#007AFF',
        borderRadius: 4,
    },
    scrubberTooltip: {
        position: 'absolute',
        right: 40,
        top: 0,
        height: 40,
        backgroundColor: '#007AFF',
        borderRadius: 20,
        justifyContent: 'center',
        paddingHorizontal: 15,
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        zIndex: 11,
    },
    scrubberTooltipText: {
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 14,
    },
    bottomSheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    bottomSheetDismissArea: {
        flex: 1,
    },
    bottomSheetContainer: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: 40,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.1,
        shadowRadius: 5,
        elevation: 10,
    },
    bottomSheetHeaderModal: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
    },
    bottomSheetTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1c1c1e',
    },
    bottomSheetSummary: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 15,
    },
    bottomSheetSummaryText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
    },
    activeUploadRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 15,
    },
    activeUploadThumb: {
        width: 48,
        height: 48,
        borderRadius: 8,
        backgroundColor: '#e5e5ea',
    },
    activeUploadName: {
        fontSize: 14,
        color: '#1c1c1e',
        marginBottom: 2,
        fontWeight: '500',
    },
    activeUploadStatsText: {
        fontSize: 11,
        color: '#8e8e93',
        marginBottom: 6,
    },
    progressBarBgSmall: {
        height: 6,
        backgroundColor: '#e5e5ea',
        borderRadius: 3,
        overflow: 'hidden',
    },
    progressBarFillSmall: {
        height: '100%',
        backgroundColor: '#007AFF',
        borderRadius: 3,
    },
    activeUploadProgText: {
        fontSize: 13,
        color: '#8e8e93',
        fontWeight: '600',
        marginLeft: 15,
        width: 36,
        textAlign: 'right',
    },
    emptyStateText: {
        textAlign: 'center',
        color: '#8e8e93',
        marginTop: 20,
        fontSize: 15,
    },
    searchHeader: {
        paddingHorizontal: 15,
        paddingTop: 15,
        paddingBottom: 15,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#ebebeb',
    },
    searchBarContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F2F2F7',
        borderRadius: 10,
        paddingHorizontal: 10,
        height: 38,
    },
    searchIcon: {
        marginRight: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
        color: '#000',
        padding: 0,
    },
    searchLoadingIndicator: {
        marginLeft: 8,
    },
    cancelButton: {
        marginLeft: 12,
        paddingVertical: 8,
    },
    cancelButtonText: {
        color: '#007AFF',
        fontSize: 16,
        fontWeight: '500',
    },
    scoreBadge: {
        position: 'absolute',
        top: 5,
        left: 5,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    scoreText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: 'bold',
    },
    tagsContainer: {
        backgroundColor: '#fff',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#ebebeb',
        paddingVertical: 8,
    },
    tagsContent: {
        paddingHorizontal: 15,
        flexDirection: 'row',
    },
    tagButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: '#f2f2f7',
        marginRight: 8,
    },
    tagButtonActive: {
        backgroundColor: '#007AFF',
    },
    tagText: {
        fontSize: 13,
        color: '#3a3a3c',
    },
    tagTextActive: {
        color: '#fff',
        fontWeight: '600',
    },
    ocrBadge: {
        position: 'absolute',
        top: 5,
        right: 5,
        backgroundColor: 'rgba(0, 122, 255, 0.85)',
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    ocrBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: 'bold',
    },
    tokensScrollView: {
        maxHeight: 28,
        marginRight: 4,
        flexGrow: 0,
    },
    tokensScrollContent: {
        alignItems: 'center',
        paddingRight: 4,
    },
    tokenChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#E5F1FF',
        borderRadius: 14,
        paddingHorizontal: 8,
        paddingVertical: 3,
        marginRight: 6,
        borderWidth: 1,
        borderColor: '#B3D7FF',
    },
    tokenChipText: {
        color: '#007AFF',
        fontSize: 12,
        fontWeight: '500',
    },
    tokenChipClose: {
        marginLeft: 4,
        padding: 2,
        justifyContent: 'center',
        alignItems: 'center',
    },
    suggestionsDropdown: {
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        height: 600,
        backgroundColor: '#ffffff',
        zIndex: 999,
        elevation: 5,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#ebebeb',
    },
    suggestionsContent: {
        paddingBottom: 20,
    },
    suggestionSection: {
        marginTop: 15,
        paddingHorizontal: 15,
    },
    suggestionSectionHeader: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#8e8e93',
        textTransform: 'uppercase',
        marginBottom: 8,
        letterSpacing: 0.5,
    },
    suggestionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#f2f2f7',
    },
    suggestionIcon: {
        marginRight: 12,
    },
    suggestionItemText: {
        fontSize: 16,
        color: '#000000',
    },
});
