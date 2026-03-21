import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, FlatList, Image, Dimensions, TouchableOpacity, Text, ActivityIndicator, RefreshControl } from 'react-native';
import { Cloud, CheckCircle, Smartphone, Trash2 } from 'lucide-react-native';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';

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

    const isMounted = React.useRef(true);
    useEffect(() => {
        isMounted.current = true;
        loadAndSync();
        return () => { isMounted.current = false; };
    }, []);

    const handleClearCache = async () => {
        try {
            setSyncing(true);
            setSyncProgress({ message: 'Clearing cache...' });
            await SyncService.clearCache();
            await loadAndSync();
        } catch (err) {
            console.error('Failed to clear cache:', err);
            setError('Failed to clear cache: ' + err.message);
        } finally {
            setSyncing(false);
            setSyncProgress(null);
        }
    };

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

            // 1. Load Local and Remote assets concurrently for instant UI rendering
            const [localResult, remoteRoot] = await Promise.all([
                MediaService.getAssets(5000),
                SyncService.fetchRemoteOverview()
            ]);
            let localAssets = localResult.assets;

            // 2. Perform Heuristic Deduplication for initial render
            const serverUrl = AuthService.getServerUrl();
            const token = AuthService.getToken();
            
            const initialAssets = localAssets.map(a => ({
                ...a,
                status: 'local'
            }));

            const localDates = localAssets.map(a => a.creationTime);

            let remoteAssets = [];
            if (remoteRoot) {
                const allRemoteNodes = [];
                const collectNodes = (node) => {
                    if (node.tag) { allRemoteNodes.push(node); return; }
                    node.children.forEach(collectNodes);
                };
                collectNodes(remoteRoot);

                remoteAssets = allRemoteNodes
                    .filter(node => {
                        if (!node.date) return true;
                        const remoteTime = node.date.getTime();
                        const hasNearbyLocal = localDates.some(localTime => Math.abs(localTime - remoteTime) <= 2000);
                        return !hasNearbyLocal;
                    })
                    .map(node => ({
                        id: `remote-${node.hash}`,
                        hash: node.hash,
                        uri: `${serverUrl}/asset/preview/${node.hash}?token=${token}`,
                        status: 'remote',
                        creationTime: node.date ? node.date.getTime() : 0,
                    }));
            }

            const combinedInitial = [...initialAssets, ...remoteAssets].sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));

            if (isMounted.current) {
                setAssets(combinedInitial);
                setLoading(false);
                setSyncing(true);
                setSyncProgress({ message: 'Starting deep crypto-sync...' });
            }

            // 3. Perform Deep Hash Crypto-Sync asynchronously
             setTimeout(async () => {
                let diff = null;
                 try {
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
                                      uri: `${serverUrl}/asset/preview/${node.hash}?token=${token}`,
                                      status: 'remote',
                                      creationTime: node.date ? node.date.getTime() : 0,
                                  }));
                          } else {
                              trueRemoteOnly = remoteAssets.filter(ra => !localHashes.has(ra.hash));
                          }

                          merged.push(...trueRemoteOnly);
                          merged.sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));
                          
                          setAssets(merged);
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

    const renderItem = ({ item }) => (
        <TouchableOpacity
            style={styles.itemContainer}
            onPress={() => navigation.navigate('AssetDetail', { asset: item })}
        >
            <Image
                source={{ uri: item.uri }}
                style={styles.image}
                onError={(e) => console.log(`[HomeScreen] Image load error for ${item.status} asset ${item.id}:`, e.nativeEvent.error)}
            />
            <StatusIcon status={item.status} />
            {item.status === 'remote' && (
                <View style={[styles.imageOverlay, { backgroundColor: 'rgba(0,0,0,0.1)' }]} />
            )}
            {/* DEBUG OVERLAY */}
            <View style={styles.debugOverlay}>
                <Text style={styles.debugText}>{item.status[0].toUpperCase()}</Text>
                <Text style={styles.debugText}>
                  {item.hash ? item.hash.substring(0, 6) : 'hash?'} 
                </Text>
            </View>
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Lomorage</Text>
                    <Text style={styles.subtitle}>
                        {assets.length} items • {syncing ? (syncProgress?.message || 'Syncing...') : 'Up to date'}
                    </Text>
                    {syncing && syncProgress && syncProgress.total && syncProgress.current !== undefined && (
                        <Text style={styles.progressText}>
                             ({syncProgress.current}/{syncProgress.total})
                        </Text>
                    )}
                </View>
                {syncing && <ActivityIndicator size="small" color="#007AFF" />}
                {!syncing && (
                    <TouchableOpacity onPress={handleClearCache} style={styles.clearButton}>
                        <Trash2 size={20} color="#666" />
                    </TouchableOpacity>
                )}
            </View>

            {error && (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorText} numberOfLines={1}>{error}</Text>
                    <TouchableOpacity onPress={loadAndSync} style={styles.retryButton}>
                        <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            )}

            {loading && assets.length === 0 ? (
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
        paddingTop: 60,
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
