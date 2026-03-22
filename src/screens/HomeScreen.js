import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, FlatList, Image, Dimensions, TouchableOpacity, Text, ActivityIndicator, RefreshControl, DeviceEventEmitter } from 'react-native';
import { Cloud, CheckCircle, Smartphone, PlayCircle, Settings as SettingsIcon } from 'lucide-react-native';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';
import { useSettings } from '../context/SettingsContext';
import GalleryStore from '../store/GalleryStore';

const { width } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const ITEM_SIZE = width / COLUMN_COUNT;

export default function HomeScreen({ navigation }) {
    const [assets, setAssets] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState(null);
    const [error, setError] = useState(null);
    const [permissionStatus, setPermissionStatus] = useState('granted');
    const [loading, setLoading] = useState(true);
    
    const { debugMode } = useSettings();

    const isMounted = React.useRef(true);
    useEffect(() => {
        isMounted.current = true;
        loadAndSync();
        
        const subDelete = DeviceEventEmitter.addListener('assetDeleted', (deletedId) => {
            setAssets(prev => prev.filter(a => a.id !== deletedId));
        });
        
        const subUpdate = DeviceEventEmitter.addListener('assetUpdated', (updatedAsset) => {
            setAssets(prev => prev.map(a => a.id === updatedAsset.id ? updatedAsset : a));
        });

        return () => { 
            isMounted.current = false; 
            subDelete.remove();
            subUpdate.remove();
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

            // 3. Update Remote Knowledge on network background
            await SyncService.fetchRemoteOverview();

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
                     if (isMounted.current) setError(syncErr.message);
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
                           merged.sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));
                           
                           // No-Op Detection: Only trigger expensive re-render if something actually changed
                           const finalJson = JSON.stringify(merged.map(a => ({ id: a.id, status: a.status })));
                           if (finalJson !== initialAssetsJson) {
                               setAssets(merged);
                           }
                           
                           setSyncing(false);
                           setSyncProgress(null);
                      }
                 }
             }, 100);

        } catch (err) {
            console.error('Error in loadAndSync:', err);
            if (isMounted.current) setError(err.message);
        } finally {
            if (isMounted.current && loading) {
                 setLoading(false);
            }
        }
    };

    const StatusIcon = ({ status }) => {
        switch (status) {
            case 'remote':
                return <Cloud size={16} color="white" style={styles.statusIcon} />;
            case 'synced':
                return <CheckCircle size={16} color="#4CAF50" style={styles.statusIcon} />;
            case 'local':
                return <Smartphone size={16} color="white" style={styles.statusIcon} />;
            default:
                return null;
        }
    };

    const renderItem = ({ item, index }) => (
        <TouchableOpacity
            style={styles.itemContainer}
            onPress={() => navigation.navigate('AssetDetail', { initialIndex: index })}
        >
            <Image
                source={{ uri: item.uri }}
                style={styles.image}
                onError={(e) => console.log(`[HomeScreen] Image load error for ${item.status} asset ${item.id}:`, e.nativeEvent.error)}
            />
            <StatusIcon status={item.status} />
            {item.mediaType === 'video' ? (
                <View style={[styles.imageOverlay, styles.videoOverlay]}>
                    <PlayCircle color="#fff" size={32} />
                </View>
            ) : null}
            {item.status === 'remote' ? (
                <View style={[styles.imageOverlay, { backgroundColor: 'rgba(0,0,0,0.1)' }]} />
            ) : null}
            {/* DEBUG OVERLAY */}
            {debugMode ? (
                <View style={styles.debugOverlay}>
                    <Text style={styles.debugText}>{item.status[0].toUpperCase()}</Text>
                    <Text style={styles.debugText}>
                      {item.hash ? item.hash.substring(0, 6) : 'hash?'} 
                    </Text>
                </View>
            ) : null}
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Lomorage</Text>
                    <Text style={styles.subtitle}>
                        {`${assets.length} items • ${syncing ? (syncProgress?.message || 'Syncing...') : 'Up to date'}`}
                    </Text>
                    {syncing && syncProgress?.total > 0 && syncProgress?.current !== undefined ? (
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
                <FlatList
                    data={assets}
                    renderItem={renderItem}
                    keyExtractor={item => item.id + (item.status || '')}
                    numColumns={COLUMN_COUNT}
                    refreshControl={
                        <RefreshControl refreshing={loading} onRefresh={loadAndSync} />
                    }
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Text>No photos found.</Text>
                        </View>
                    }
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
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
    }
});
