import React, { useEffect, useState, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, Dimensions, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { PlayCircle, Heart } from 'lucide-react-native';
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
    const navigation = useNavigation();
    const route = useRoute();
    const { albumId, albumName } = route.params;

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
                
                const formattedAssets = hashes.map((hash, index) => {
                    const localAsset = dbAssets.find(a => a.hash === hash);
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
        navigation.navigate('AssetDetail', { initialIndex: index, source: `album_${albumId}` });
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
                    source={item.localCachePath ? { uri: item.localCachePath } : { uri: item.uri }}
                    style={styles.image}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={0}
                    recyclingKey={item.id ? String(item.id) : null}
                />
                {isVideo && (
                    <View style={[styles.imageOverlay, styles.videoOverlay]}>
                        <PlayCircle color="#fff" size={32} />
                    </View>
                )}
                {item.isFavorite && albumName !== 'Favorites' && albumName !== '/Favorites' && (
                    <View style={styles.favoriteIndicator}>
                        <Heart color="#ef4444" fill="#ef4444" size={14} />
                    </View>
                )}
            </TouchableOpacity>
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.canGoBack() && navigation.goBack()} style={styles.iconButton}>
                    <Text style={{fontSize: 24, paddingHorizontal: 10}}>‹</Text>
                </TouchableOpacity>
                <Text style={styles.title} numberOfLines={1}>{albumName || 'Album'}</Text>
                <View style={{ width: 44 }} />
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
                    estimatedItemSize={ITEM_SIZE}
                    numColumns={NUM_COLUMNS}
                    contentContainerStyle={{ padding: SPACING }}
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
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingTop: 15,
        paddingBottom: 15,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1a1a1a',
        flex: 1,
        textAlign: 'center',
    },
    iconButton: {
        padding: 5,
        width: 44,
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
    imageOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.1)',
    },
    videoOverlay: {
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
    },
    favoriteIndicator: {
        position: 'absolute',
        top: 4,
        right: 4,
        backgroundColor: 'rgba(255,255,255,0.7)',
        borderRadius: 10,
        padding: 2,
    },
    emptyText: {
        fontSize: 16,
        color: '#666',
    }
});
