import React, { useEffect, useState, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, Dimensions, ActivityIndicator, TouchableOpacity, Alert, Modal, TextInput, KeyboardAvoidingView, Platform, DeviceEventEmitter } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { PlayCircle, Heart, CheckCircle2, Circle, MoreVertical, Trash2 } from 'lucide-react-native';
import RemoteAlbumService from '../services/RemoteAlbumService';
import NetworkQueue from '../services/NetworkQueue';
import AssetDBService from '../services/AssetDBService';
import GalleryStore from '../store/GalleryStore';
import AuthService from '../services/AuthService';

const { width } = Dimensions.get('window');
const SPACING = 2;
const NUM_COLUMNS = 4;
const ITEM_SIZE = (width - SPACING * (NUM_COLUMNS + 1)) / NUM_COLUMNS;

export default function AlbumDetailScreen() {
    const [assets, setAssets] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectMode, setSelectMode] = useState(false);
    const [selectedHashes, setSelectedHashes] = useState(new Set());
    const [promptState, setPromptState] = useState({ visible: false, text: '' });
    const navigation = useNavigation();
    const route = useRoute();
    const { albumId, albumName: initialAlbumName, fullPath: initialFullPath } = route.params;
    const [albumName, setAlbumName] = useState(initialAlbumName);
    const [fullPath, setFullPath] = useState(initialFullPath || initialAlbumName);

    const isSystemAlbum = !albumId || albumName.startsWith('/') || albumName === 'Favorites';

    // useLayoutEffect(() => {
    //     navigation.setOptions({
    //         title: albumName || 'Album',
    //         headerShown: true,
    //     });
    // }, [navigation, albumName]);

    useFocusEffect(
        React.useCallback(() => {
            // Only load if we haven't loaded yet
            if (assets.length === 0) {
                loadAlbumAssets();
            }
            
            return () => {
                NetworkQueue.cancelGroup('AlbumDetail');
            };
        }, [albumId, assets.length]) // dependency on albumId
    );

    useEffect(() => {
        const sub1 = DeviceEventEmitter.addListener('albumAssetsUpdated', (updatedAlbumId) => {
            if (String(updatedAlbumId) === String(albumId)) {
                loadAlbumAssets();
            }
        });
        const sub2 = DeviceEventEmitter.addListener('assetRemovedFromAlbum', ({ albumId: updatedAlbumId, hash }) => {
            if (String(updatedAlbumId) === String(albumId)) {
                setAssets(prev => {
                    const newAssets = prev.filter(a => a.hash !== hash);
                    GalleryStore.setAssets(newAssets, `album_${albumId}`);
                    return newAssets;
                });
            }
        });
        return () => {
            sub1.remove();
            sub2.remove();
        };
    }, [albumId]);

    const loadAlbumAssets = async () => {
        setLoading(true);
        try {
            // 1. Get asset hashes for this album from server
            const hashes = await RemoteAlbumService.getAlbumAssets(albumId, { priority: 1, groupId: 'AlbumDetail' });
            
            if (hashes.length > 0) {
                // 2. Fetch full metadata from local SQLite cache (for the ones we have)
                const dbAssets = await AssetDBService.getAssetsByHashes(hashes);
                
                // 3. Format them for display. We MUST display all hashes, even if not in DB.
                const serverUrl = AuthService.getServerUrl();
                const token = AuthService.getToken();
                
                // Convert dbAssets to Map for O(1) lookup
                const dbAssetsMap = new Map();
                for (let i = 0; i < dbAssets.length; i++) {
                    dbAssetsMap.set(dbAssets[i].hash, dbAssets[i]);
                }
                
                const formattedAssets = hashes.map((hash, index) => {
                    const localAsset = dbAssetsMap.get(hash);
                    return {
                        id: localAsset ? localAsset.id : hash, // Use hash as ID to prevent FlatList key collisions
                        hash: hash,
                        uri: `${serverUrl}/preview/${hash}?width=320&height=-1&token=${token}`,
                        status: 'remote',
                        creationTime: localAsset ? localAsset.creationTime : Date.now(),
                        mediaType: localAsset ? localAsset.mediaType : 'image', // Fallback to image if not in DB
                        isFavorite: localAsset ? localAsset.isFavorite : false,
                        localCachePath: localAsset ? localAsset.localCachePath : null,
                        isMetadataPartial: !localAsset
                    };
                });
                
                setAssets(formattedAssets);
                // Also update GalleryStore so swiping works in full screen view
                GalleryStore.setAssets(formattedAssets, `album_${albumId}`);
            } else {
                setAssets([]);
                GalleryStore.setAssets([], `album_${albumId}`);
            }
        } catch (error) {
            console.error('[AlbumDetailScreen] Failed to load album assets:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleAssetPress = (item, index) => {
        if (selectMode) {
            const newSet = new Set(selectedHashes);
            if (newSet.has(item.hash)) {
                newSet.delete(item.hash);
            } else {
                newSet.add(item.hash);
            }
            setSelectedHashes(newSet);
        } else {
            navigation.navigate('AssetDetail', { initialIndex: index, source: `album_${albumId}` });
        }
    };

    const handleBatchRemove = () => {
        if (selectedHashes.size === 0) return;
        Alert.alert(
            'Remove Photos',
            `Are you sure you want to remove ${selectedHashes.size} photos from this album?`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: async () => {
                    setLoading(true);
                    for (const hash of selectedHashes) {
                        await RemoteAlbumService.removeAssetFromAlbum(albumId, hash);
                    }
                    setAssets(prev => {
                        const newAssets = prev.filter(a => !selectedHashes.has(a.hash));
                        GalleryStore.setAssets(newAssets, `album_${albumId}`);
                        return newAssets;
                    });
                    setSelectedHashes(new Set());
                    setSelectMode(false);
                    setLoading(false);
                }}
            ]
        );
    };

    const handleMenuPress = () => {
        Alert.alert(
            'Album Options',
            `Manage "${albumName}"`,
            [
                { text: 'Rename', onPress: () => setPromptState({ visible: true, text: albumName }) },
                { text: 'Delete', style: 'destructive', onPress: confirmDeleteAlbum },
                { text: 'Cancel', style: 'cancel' }
            ]
        );
    };

    const confirmDeleteAlbum = () => {
        Alert.alert(
            'Delete Album',
            `Are you sure you want to delete "${albumName}"? This will not delete the photos inside.`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: async () => {
                    RemoteAlbumService.deleteAlbumFromTree(albumId);
                    DeviceEventEmitter.emit('albumDeleted', albumId);
                    await RemoteAlbumService.deleteAlbum(albumId);
                    navigation.goBack();
                }}
            ]
        );
    };

    const handlePromptSubmit = async () => {
        const text = promptState.text.trim();
        if (!text) {
            setPromptState({ visible: false, text: '' });
            return;
        }
        
        let newFullPath = text;
        if (fullPath && fullPath.includes('/')) {
            const parts = fullPath.split('/');
            if (parts[parts.length - 1] === '') {
                parts.pop();
            }
            parts[parts.length - 1] = newFullPath;
            newFullPath = parts.join('/');
        }

        setPromptState({ visible: false, text: '' });
        setLoading(true);
        RemoteAlbumService.renameAlbumInTree(albumId, text, newFullPath);
        DeviceEventEmitter.emit('albumRenamed', { albumId, newName: text, newFullPath });
        const success = await RemoteAlbumService.updateAlbumInfo(albumId, newFullPath);
        if (success) {
            setAlbumName(text);
            setFullPath(newFullPath);
        }
        setLoading(false);
    };

    const renderItem = ({ item, index }) => {
        const isVideo = item.mediaType === 'video';
        return (
            <TouchableOpacity 
                activeOpacity={0.8} 
                onPress={() => handleAssetPress(item, index)}
                style={styles.itemContainer}
            >
                <Image
                    source={(item.localCachePath && item.mediaType !== 'video') ? { uri: item.localCachePath } : { uri: item.uri }}
                    style={styles.image}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={0}
                    recyclingKey={item.id ? String(item.id) : null}
                />
                {isVideo && (
                    <View style={styles.videoIndicator}>
                        <PlayCircle color="#fff" size={20} />
                    </View>
                )}
                {item.isFavorite && albumName !== 'Favorites' && albumName !== '/Favorites' && (
                    <View style={styles.favoriteIndicator}>
                        <Heart color="#ef4444" fill="#ef4444" size={14} />
                    </View>
                )}
                {selectMode && (
                    <View style={styles.selectOverlay}>
                        {selectedHashes.has(item.hash) ? (
                            <CheckCircle2 color="#007AFF" fill="#fff" size={24} />
                        ) : (
                            <Circle color="#fff" size={24} />
                        )}
                    </View>
                )}
            </TouchableOpacity>
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {selectMode ? (
                    <>
                        <TouchableOpacity onPress={() => { setSelectMode(false); setSelectedHashes(new Set()); }} style={styles.headerBtn}>
                            <Text style={styles.headerBtnText}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={styles.title}>
                            {selectedHashes.size > 0 ? `${selectedHashes.size} Selected` : 'Select Items'}
                        </Text>
                        <TouchableOpacity 
                            onPress={() => setSelectedHashes(selectedHashes.size === assets.length ? new Set() : new Set(assets.map(a => a.hash)))} 
                            style={styles.headerBtn}
                        >
                            <Text style={styles.headerBtnText}>{selectedHashes.size === assets.length ? 'Deselect All' : 'Select All'}</Text>
                        </TouchableOpacity>
                    </>
                ) : (
                    <>
                        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
                            <Text style={styles.headerBtnText}>Back</Text>
                        </TouchableOpacity>
                        <Text style={styles.title} numberOfLines={1}>{albumName}</Text>
                        <View style={{ flexDirection: 'row' }}>
                            <TouchableOpacity onPress={() => setSelectMode(true)} style={styles.headerBtn}>
                                <Text style={styles.headerBtnText}>Select</Text>
                            </TouchableOpacity>
                            {!isSystemAlbum && (
                                <TouchableOpacity onPress={handleMenuPress} style={styles.headerIconBtn}>
                                    <MoreVertical color="#007AFF" size={24} />
                                </TouchableOpacity>
                            )}
                        </View>
                    </>
                )}
            </View>

            {loading && assets.length === 0 ? (
                <View style={styles.centerContainer}>
                    <ActivityIndicator size="large" color="#007AFF" />
                </View>
            ) : assets.length === 0 ? (
                <View style={styles.centerContainer}>
                    <Text style={styles.emptyText}>No photos in this album</Text>
                </View>
            ) : (
                <FlashList
                    data={assets}
                    renderItem={renderItem}
                    keyExtractor={(item, index) => `${item.id || item.hash}_${index}`}
                    estimatedItemSize={ITEM_SIZE}
                    numColumns={NUM_COLUMNS}
                    contentContainerStyle={{ padding: SPACING }}
                    refreshing={loading}
                    onRefresh={loadAlbumAssets}
                />
            )}

            {selectMode && (
                <View style={styles.bottomToolbar}>
                    <TouchableOpacity 
                        style={[styles.toolbarBtn, selectedHashes.size === 0 && { opacity: 0.5 }]} 
                        disabled={selectedHashes.size === 0}
                        onPress={handleBatchRemove}
                    >
                        <Trash2 color="#ef4444" size={24} />
                        <Text style={styles.toolbarBtnText}>Remove from Album</Text>
                    </TouchableOpacity>
                </View>
            )}

            <Modal
                visible={promptState.visible}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setPromptState({ visible: false, text: '' })}
            >
                <KeyboardAvoidingView 
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.modalOverlay}
                >
                    <View style={styles.promptContainer}>
                        <Text style={styles.promptTitle}>Rename Album</Text>
                        <TextInput
                            style={styles.promptInput}
                            value={promptState.text}
                            onChangeText={t => setPromptState(prev => ({ ...prev, text: t }))}
                            placeholder="Album Name"
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={handlePromptSubmit}
                        />
                        <View style={styles.promptActions}>
                            <TouchableOpacity style={styles.promptBtn} onPress={() => setPromptState({ visible: false, text: '' })}>
                                <Text style={styles.promptBtnCancel}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.promptBtn} onPress={handlePromptSubmit}>
                                <Text style={styles.promptBtnSubmit}>Save</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 15,
        paddingBottom: 15,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    headerBtn: {
        paddingVertical: 5,
        paddingHorizontal: 8,
    },
    headerIconBtn: {
        paddingVertical: 5,
        paddingHorizontal: 5,
        marginLeft: 10,
    },
    headerBtnText: {
        color: '#007AFF',
        fontSize: 16,
        fontWeight: '500',
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1a1a1a',
        maxWidth: '50%',
        textAlign: 'center',
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#fff',
    },
    itemContainer: {
        width: ITEM_SIZE,
        height: ITEM_SIZE,
        margin: SPACING / 2,
        backgroundColor: '#eee',
    },
    image: {
        width: '100%',
        height: '100%',
    },
    videoIndicator: {
        position: 'absolute',
        bottom: 5,
        left: 5,
    },
    favoriteIndicator: {
        position: 'absolute',
        bottom: 5,
        right: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.3,
        shadowRadius: 1,
        elevation: 2,
    },
    selectOverlay: {
        position: 'absolute',
        top: 5,
        right: 5,
        backgroundColor: 'rgba(255,255,255,0.4)',
        borderRadius: 12,
    },
    bottomToolbar: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 15,
        paddingBottom: 30,
        backgroundColor: '#f8f8f8',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#d1d1d6',
    },
    toolbarBtn: {
        alignItems: 'center',
        flexDirection: 'row',
    },
    toolbarBtnText: {
        color: '#ef4444',
        fontSize: 16,
        fontWeight: '500',
        marginLeft: 8,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    promptContainer: {
        width: '80%',
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 20,
        alignItems: 'center',
    },
    promptTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16,
        color: '#333',
    },
    promptInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        marginBottom: 20,
        backgroundColor: '#f9f9f9',
    },
    promptActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        width: '100%',
    },
    promptBtn: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        marginLeft: 10,
    },
    promptBtnCancel: {
        fontSize: 16,
        color: '#666',
    },
    promptBtnSubmit: {
        fontSize: 16,
        fontWeight: '600',
        color: '#007AFF',
    },
    emptyText: {
        fontSize: 16,
        color: '#666',
    }
});
