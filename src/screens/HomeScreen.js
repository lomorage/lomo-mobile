import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { StyleSheet, View, FlatList, Image, Dimensions, TouchableOpacity, Text, ActivityIndicator, RefreshControl, DeviceEventEmitter, AppState, PanResponder, Animated } from 'react-native';
import { Cloud, CheckCircle, Smartphone, PlayCircle, PauseCircle, Settings as SettingsIcon, UploadCloud } from 'lucide-react-native';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';
import AutoBackupManager from '../services/AutoBackupManager';
import { useSettings } from '../context/SettingsContext';
import GalleryStore from '../store/GalleryStore';

const { width } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const ITEM_SIZE = width / COLUMN_COUNT;

export default function HomeScreen({ navigation }) {
    const [assets, setAssets] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState(null);
    const [backupState, setBackupState] = useState({ isBackingUp: false, pendingCount: 0, totalCount: 0, currentAssetId: null });
    const [backupProgress, setBackupProgress] = useState(0);
    const [error, setError] = useState(null);
    const [permissionStatus, setPermissionStatus] = useState('granted');
    const [loading, setLoading] = useState(true);
    
    const { debugMode } = useSettings();

    const isMounted = useRef(true);
    const appState = useRef(AppState.currentState);

    const listRef = useRef(null);
    const containerRef = useRef(null);
    const scrubberPageYRef = useRef(0);
    const containerHeightRef = useRef(0);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubText, setScrubText] = useState('');
    const isScrubbingRef = useRef(false);
    const lastScrubIndexRef = useRef(-1);
    const scrubThumbY = useRef(new Animated.Value(0)).current;
    const scrubTooltipY = useRef(new Animated.Value(0)).current;
    const timelineDataRef = useRef([]);
    const stickyHeaderIndicesRef = useRef([]);
    const lastJumpTimeRef = useRef(0);

    const safeUri = useCallback((uri) => {
        if (!uri) return null;
        if (uri.startsWith('http')) return uri;
        if (uri.startsWith('content://')) return uri;
        
        let path = uri;
        if (path.startsWith('file://')) {
            path = path.substring(7);
        }
        
        // Ensure path starts with / on Android
        if (!path.startsWith('/')) {
            path = '/' + path;
        }
        
        // Encode the path to handle spaces and dots correctly
        // We use split and map to only encode the segments, not the slashes
        const segments = path.split('/').map(segment => encodeURIComponent(segment));
        return 'file://' + segments.join('/');
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
        if (!assets || assets.length === 0) return { timelineData: data, stickyHeaderIndices: indices };

        const dateCache = new Map();
        let currentHeaderKey = null;
        let currentRowItems = [];
        let currentOffset = 0;

        const pushRow = () => {
            if (currentRowItems.length > 0) {
                data.push({ type: 'row', id: `row-${data.length}`, items: currentRowItems, length: ITEM_SIZE, offset: currentOffset });
                currentOffset += ITEM_SIZE;
                currentRowItems = [];
            }
        };

        assets.forEach((asset, globalIndex) => {
            // Priority: 1. CreationTime (EXIF), 2. ModificationTime (File Metadata), 3. 0 fallback
            const time = asset.creationTime || asset.modificationTime || 0;
            const d = new Date(time);
            
            // Fast integer-based key for grouping (YYYYMMDD for Today/Yesterday, otherwise YYYYMM)
            const now = new Date();
            const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            const isYesterday = d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear();
            
            let headerKey;
            if (isToday) headerKey = 'today';
            else if (isYesterday) headerKey = 'yesterday';
            else {
                // Monthly grouping for everything else to eliminate gaps
                headerKey = d.getFullYear() * 100 + (d.getMonth() + 1);
            }

            if (headerKey !== currentHeaderKey) {
                pushRow();
                currentHeaderKey = headerKey;
                
                // Only call expensive formatting once per unique headerKey
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
    }, [assets]);

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
        
        const subDelete = DeviceEventEmitter.addListener('assetDeleted', (deletedId) => {
            setAssets(prev => prev.filter(a => a.id !== deletedId));
        });
        
        const subUpdate = DeviceEventEmitter.addListener('assetUpdated', (updatedAsset) => {
            setAssets(prev => prev.map(a => a.id === updatedAsset.id ? updatedAsset : a));
        });
        
        const subBackupState = DeviceEventEmitter.addListener('backupState', setBackupState);
        const subBackupProgress = DeviceEventEmitter.addListener('backupProgress', (data) => {
            setBackupProgress(data.progress || 0);
        });

        return () => { 
            isMounted.current = false; 
            subscription.remove();
            subDelete.remove();
            subUpdate.remove();
            subBackupState.remove();
            subBackupProgress.remove();
        };
    }, []);

    useEffect(() => {
        GalleryStore.setAssets(assets);
    }, [assets]);

    const loadAndSync = async () => {
        setLoading(true);
        setError(null);
        try {
            const granted = await MediaService.requestPermissions();
            setPermissionStatus(granted ? 'granted' : 'denied');
            if (!granted) {
                setLoading(false);
                return;
            }

            // 1. Load Local assets and Disk Caches concurrently for instant UI rendering
            const [localResult] = await Promise.all([
                MediaService.getAssets(5000),
                SyncService.loadLocalHashCache(),
                SyncService.loadRemoteTree()
            ]);
            let localAssets = localResult.assets;

            const isVideoExtension = (filename) => {
                if (!filename) return false;
                const ext = filename.split('.').pop().toLowerCase();
                return ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext);
            };

            // 2. Perform Intelligent Heuristic Deduplication for instant render
            const serverUrl = AuthService.getServerUrl();
            const token = AuthService.getToken();
            
            // Use local hash cache to identify synced items even before deep sync
            const initialAssets = localAssets.map(a => {
                const cached = SyncService.localHashCache[a.id];
                const hash = a.hash || cached?.hash;
                const isSynced = hash && SyncService.remoteTree?.getNodeByHash(hash);
                return {
                    ...a,
                    hash: hash || a.hash,
                    status: isSynced ? 'synced' : 'local'
                };
            });

            const localHashes = new Set(initialAssets.filter(a => a.hash).map(a => a.hash));
            const localDates = localAssets.map(a => a.creationTime);

            let remoteAssets = [];
            if (SyncService.remoteTree) {
                const allRemoteNodes = [];
                const collectNodes = (node) => {
                    if (node.tag) { allRemoteNodes.push(node); return; }
                    node.children.forEach(collectNodes);
                };
                collectNodes(SyncService.remoteTree);

                remoteAssets = allRemoteNodes
                    .filter(node => {
                        // 100% Match: Hash already exists in local list
                        if (localHashes.has(node.hash)) return false;
                        
                        // Heuristic Match: Date proximity (fallback for unhashed items)
                        if (node.date) {
                            const remoteTime = node.date.getTime();
                            const hasNearbyLocal = localDates.some(localTime => Math.abs(localTime - remoteTime) <= 2000);
                            if (hasNearbyLocal) return false;
                        }
                        return true;
                    })
                    .map(node => ({
                        id: `remote-${node.hash}`,
                        hash: node.hash,
                        uri: `${serverUrl}/preview/${node.hash}?width=500&height=-1&token=${token}`,
                        status: 'remote',
                        creationTime: node.date ? node.date.getTime() : 0,
                        mediaType: isVideoExtension(node.tag) ? 'video' : 'photo'
                    }));
            }

            const combinedInitial = [...initialAssets, ...remoteAssets].sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));

            if (isMounted.current) {
                setAssets(combinedInitial);
                setLoading(false);
                setSyncing(true);
            }

            // 3. Update Remote Knowledge on network background (gracefully handle failures)
            try {
                await SyncService.fetchRemoteOverview();
            } catch (err) {
                console.warn('[HomeScreen] Remote overview failed:', err.message);
                // We don't throw here, just continue with local assets and let deep sync handle it
            }

            // 4. Perform Deep Hash Crypto-Sync asynchronously
             setTimeout(async () => {
                let diff = null;
                const initialAssetsJson = JSON.stringify(combinedInitial.map(a => ({ id: a.id, status: a.status })));
                 try {
                     setSyncProgress({ message: 'Syncing with server...' });
                    diff = await SyncService.sync(localAssets, (progress) => {
                        if (!isMounted.current) return;
                        setSyncProgress(progress);
                        
                        if (progress.triggerUiUpdate) {
                            // Efficiently update only the items that got new hashes
                            const localHashMap = new Map(localAssets.map(a => [a.id, a.hash]));
                            setAssets(currentAssets => {
                                let changed = false;
                                const next = currentAssets.map(item => {
                                    if (item.status === 'local' || item.status === 'synced') {
                                        const latestHash = localHashMap.get(item.id);
                                        if (latestHash !== undefined && latestHash !== item.hash) {
                                            changed = true;
                                            const remoteNode = SyncService.remoteTree?.getNodeByHash(latestHash);
                                            return { 
                                                ...item, 
                                                hash: latestHash,
                                                status: remoteNode ? 'synced' : 'local'
                                            };
                                        }
                                    }
                                    return item;
                                });
                                return changed ? next : currentAssets;
                            });
                        }
                    });

                    if (!isMounted.current) return;

                    const localWithHash = localAssets.filter(a => a.hash).length;
                    console.log('[HomeScreen] Deep sync finished. Diff:', {
                        upload: diff?.uploadAssets?.length,
                        download: diff?.downloadAssets?.length,
                        localWithHash,
                    });
                    
                 } catch (syncErr) {
                     console.error('Error during async sync:', syncErr);
                     if (isMounted.current) setError(String(syncErr.message || syncErr));
                 } finally {
                     if (isMounted.current) {
                          // Final merge to catch any remainder and true download assets
                          const merged = localAssets.map(a => {
                              const hash = a.hash;
                              if (!hash) return { ...a, status: 'local' };
                              const remoteNode = SyncService.remoteTree?.getNodeByHash(hash);
                              return {
                                  ...a,
                                  hash,
                                  status: remoteNode ? 'synced' : 'local'
                              };
                          });

                          const localHashes = new Set(merged.filter(a => a.hash).map(a => a.hash));
                          let trueRemoteOnly = [];
                          if (diff && diff.downloadAssets) {
                              trueRemoteOnly = diff.downloadAssets
                                  .filter(node => !localHashes.has(node.hash))
                                  .map(node => ({
                                      id: `remote-${node.hash}`,
                                      hash: node.hash,
                                      uri: `${serverUrl}/preview/${node.hash}?width=500&height=-1&token=${token}`,
                                      status: 'remote',
                                      creationTime: node.date ? node.date.getTime() : 0,
                                      mediaType: isVideoExtension(node.tag) ? 'video' : 'photo'
                                  }));
                          } else {
                              // Fallback: If sync failed, use precisely the same heuristic as before
                              trueRemoteOnly = remoteAssets.filter(ra => !localHashes.has(ra.hash));
                          }

                          merged.push(...trueRemoteOnly);
                                merged.sort((a, b) => (b.creationTime || b.modificationTime || 0) - (a.creationTime || a.modificationTime || 0));
                                
                                // No-Op Detection: Only trigger expensive re-render if something actually changed
                                const finalJson = JSON.stringify(merged.map(a => ({ id: a.id, status: a.status })));
                                if (finalJson !== initialAssetsJson) {
                                    GalleryStore.setAssets(merged);
                                    setAssets(merged);
                                    AutoBackupManager.syncQueueWithGallery(); // Restart queue on changes
                                }
                           
                           setSyncing(false);
                           setSyncProgress(null);
                           
                           // Ensure queue starts safely if there are pending items post-load
                           AutoBackupManager.syncQueueWithGallery();
                      }
                 }
             }, 100);

        } catch (err) {
            console.error('Initial load error:', err);
            if (isMounted.current) setError(String(err.message || err));
        } finally {
            if (isMounted.current && loading) {
                 setLoading(false);
            }
        }
    };

    const StatusIcon = memo(({ item, currentAssetId }) => {
        if (item.id === currentAssetId) {
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

    const RenderAsset = memo(({ asset, globalIndex, navigation, debugMode, currentAssetId, isScrubbing }) => {
        // Scrub-Lock: Skip remote photo fetching while scrubbing to prevent network congestion.
        // Local assets are fine to render because they are fast and don't hit the server.
        const shouldShowImage = !isScrubbing || asset.status === 'local';

        return (
            <TouchableOpacity
                key={`asset-${asset.id}`}
                style={styles.itemContainer}
                onPress={() => navigation.navigate('AssetDetail', { initialIndex: globalIndex })}
            >
                {shouldShowImage ? (
                    <Image
                        source={{ uri: safeUri(asset.uri) }}
                        style={styles.image}
                        resizeMethod="resize"
                        onError={(e) => {
                             // Only log if not a common ENOENT on a weird filename (too verbose)
                             if (debugMode) console.log(`[HomeScreen] Image load error for ${asset.status} asset ${asset.id}:`, e.nativeEvent.error);
                        }}
                    />
                ) : (
                    <View style={[styles.image, { backgroundColor: '#f0f0f0' }]} />
                )}
                <StatusIcon item={asset} currentAssetId={currentAssetId} />
                {asset.mediaType === 'video' ? (
                    <View style={[styles.imageOverlay, styles.videoOverlay]}>
                        <PlayCircle color="#fff" size={32} />
                    </View>
                ) : null}
                {asset.status === 'remote' ? (
                    <View style={[styles.imageOverlay, { backgroundColor: 'rgba(0,0,0,0.1)' }]} />
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
        if (prevProps.isScrubbing !== nextProps.isScrubbing) return false;
        if (prevProps.asset.id !== nextProps.asset.id || prevProps.asset.status !== nextProps.asset.status) return false;
        if (prevProps.debugMode !== nextProps.debugMode) return false;
        if (prevProps.currentAssetId !== nextProps.currentAssetId && (prevProps.asset.id === prevProps.currentAssetId || prevProps.asset.id === nextProps.currentAssetId)) return false;
        return true;
    });

    const TimelineRow = memo(({ item, navigation, debugMode, currentAssetId, isScrubbing }) => (
        <View style={styles.row}>
            {item.items.map((asset) => (
                <RenderAsset 
                    key={asset.id}
                    asset={asset} 
                    globalIndex={asset.globalIndex} 
                    navigation={navigation}
                    debugMode={debugMode}
                    currentAssetId={currentAssetId}
                    isScrubbing={isScrubbing}
                />
            ))}
            {Array.from({ length: COLUMN_COUNT - item.items.length }).map((_, i) => (
                <View key={`empty-${i}`} style={styles.itemContainer} />
            ))}
        </View>
    ));

    const renderItem = useCallback(({ item }) => {
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
                debugMode={debugMode}
                currentAssetId={backupState.currentAssetId}
                isScrubbing={isScrubbing}
            />
        );
    }, [navigation, debugMode, backupState.currentAssetId, isScrubbing]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Lomorage</Text>
                    <Text style={styles.subtitle}>
                        {`${assets.length} items${syncing ? ` • ${debugMode ? (syncProgress?.message || 'Syncing...') : 'Looking for new photos...'}` : error ? ' • Offline' : ''}`}
                    </Text>
                    {debugMode && syncing && syncProgress?.total > 0 && syncProgress?.current !== undefined ? (
                        <Text style={styles.progressText}>
                             {`(${syncProgress.current}/${syncProgress.total})`}
                        </Text>
                    ) : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {syncing ? <ActivityIndicator size="small" color="#007AFF" style={{ marginRight: 10 }} /> : null}
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={styles.settingsButton}>
                        <SettingsIcon size={24} color="#333" />
                    </TouchableOpacity>
                </View>
            </View>

            {backupState.isBackingUp || (backupState.isPaused && backupState.pendingCount > 0) ? (
                <View style={[styles.backupBanner, backupState.isPaused && { backgroundColor: '#f5f5f5' }]}>
                    <View style={styles.backupBannerTop}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            {backupState.currentAssetId && !backupState.isPaused ? (
                                <Image 
                                    source={{ uri: assets.find(a => a.id === backupState.currentAssetId)?.uri }} 
                                    style={styles.uploadingThumbnail} 
                                />
                            ) : null}
                            <Text style={[styles.backupBannerText, backupState.isPaused && { color: '#666' }]}>
                                {backupState.isPaused ? `Backup Paused (${backupState.pendingCount} items)` : `Backing up ${backupState.pendingCount} left...`}
                            </Text>
                        </View>
                        {backupState.isPaused ? (
                            <TouchableOpacity onPress={() => AutoBackupManager.resume()} style={{ padding: 4 }}>
                                <PlayCircle size={22} color="#007AFF" />
                            </TouchableOpacity>
                        ) : (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <ActivityIndicator size="small" color="#007AFF" style={{ marginRight: 12 }} />
                                <TouchableOpacity onPress={() => AutoBackupManager.pause()} style={{ padding: 4 }}>
                                    <PauseCircle size={22} color="#007AFF" />
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                    <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: `${backupProgress * 100}%`, backgroundColor: backupState.isPaused ? '#ccc' : '#007AFF' }]} />
                    </View>
                </View>
            ) : backupState.totalCount > 0 && !backupState.isPaused ? (
                <View style={[styles.backupBanner, { backgroundColor: '#E8F5E9', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
                    <Text style={[styles.backupBannerText, { color: '#2E7D32' }]}>
                        Backup complete ({backupState.totalCount})
                    </Text>
                    <CheckCircle size={16} color="#2E7D32" />
                </View>
            ) : null}

            {error ? (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorText} numberOfLines={1}>{error}</Text>
                    <TouchableOpacity onPress={loadAndSync} style={styles.retryButton}>
                        <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                </View>
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
                    <FlatList
                        ref={listRef}
                        data={timelineData}
                        renderItem={renderItem}
                        keyExtractor={item => item.id}
                        stickyHeaderIndices={stickyHeaderIndices}
                        getItemLayout={getItemLayout}
                        removeClippedSubviews={false}
                        initialNumToRender={10}
                        maxToRenderPerBatch={10}
                        windowSize={5}
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
                                <Text>No photos found.</Text>
                            </View>
                        }
                    />

                    {timelineData.length > 30 && (
                        <View 
                            style={styles.scrubberHitbox}
                            {...panResponder.panHandlers}
                        >
                            <Animated.View style={[styles.scrollThumb, { transform: [{ translateY: scrubThumbY }] }]} />
                        </View>
                    )}

                    {isScrubbing && (
                        <Animated.View style={[styles.scrubTooltip, { transform: [{ translateY: scrubTooltipY }] }]}>
                            <Text style={styles.scrubTooltipText}>{scrubText}</Text>
                        </Animated.View>
                    )}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    row: {
        flexDirection: 'row',
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
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFEBEE',
        padding: 10,
        marginHorizontal: 15,
        borderRadius: 8,
        marginBottom: 10,
    },
    backupBanner: {
        backgroundColor: '#F0F8FF',
        padding: 12,
        marginHorizontal: 15,
        borderRadius: 8,
        marginBottom: 10,
        justifyContent: 'center',
    },
    backupBannerTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8,
    },
    backupBannerText: {
        color: '#007AFF',
        fontSize: 14,
        fontWeight: 'bold',
    },
    uploadingThumbnail: {
        width: 24,
        height: 24,
        borderRadius: 4,
        marginRight: 8,
        backgroundColor: '#ccc',
    },
    progressBarBg: {
        height: 4,
        width: '100%',
        backgroundColor: 'rgba(0,122,255,0.2)',
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: '#007AFF',
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
        width: ITEM_SIZE,
        height: ITEM_SIZE,
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
    clearButton: {
        padding: 5,
        marginLeft: 10,
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
        fontSize: 10,
        fontWeight: 'bold',
        textAlign: 'center'
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
    scrubberHitbox: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 30,
        zIndex: 10,
    },
    scrollThumb: {
        position: 'absolute',
        right: 4,
        top: 0,
        width: 6,
        height: 40,
        backgroundColor: 'rgba(0,122,255,0.6)',
        borderRadius: 4,
    },
    scrubTooltip: {
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
    scrubTooltipText: {
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 14,
    }
});
