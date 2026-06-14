import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { Folder, Users, Image as ImageIcon } from 'lucide-react-native';
import RemoteAlbumService from '../services/RemoteAlbumService';
import NetworkQueue from '../services/NetworkQueue';

const { width } = Dimensions.get('window');
const SPACING = 16;

export default function AlbumsScreen() {
    const [collection, setCollection] = useState(null);
    const [loading, setLoading] = useState(true);
    const navigation = useNavigation();

    useFocusEffect(
        React.useCallback(() => {
            loadAlbums();
            
            // Clean up: when user leaves Albums tab, abort any pending Album requests
            return () => {
                NetworkQueue.cancelGroup('Albums');
            };
        }, [])
    );

    const loadAlbums = async () => {
        setLoading(true);
        try {
            const rootCollection = await RemoteAlbumService.getAlbumsHierarchy({ priority: 1, groupId: 'Albums' });
            setCollection(rootCollection);
        } catch (error) {
            console.error('[AlbumsScreen] Failed to load albums', error);
        } finally {
            setLoading(false);
        }
    };

    const handleAlbumPress = (album) => {
        navigation.navigate('AlbumDetail', { albumId: album.info.id, albumName: album.name });
    };

    const handleFolderPress = (folder) => {
        navigation.navigate('FolderDetail', { folderPath: folder.fullPath, folderName: folder.name });
    };

    const renderItem = ({ item }) => {
        const isFolder = item.type === 'folder';
        const data = item.data;
        
        let count = 0;
        let isFaces = false;
        let coverUri = null;
        
        if (isFolder) {
            count = (data.folders ? data.folders.size : 0) + (data.albums ? data.albums.size : 0);
            isFaces = data.name === 'Faces' || (data.fullPath && data.fullPath.includes('/Faces'));
        } else {
            count = data.info && data.info.count ? data.info.count : 0;
            if (data.info && data.info.coverImage) {
                coverUri = data.info.coverImage.startsWith('data:') 
                    ? data.info.coverImage 
                    : 'data:image/jpeg;base64,' + data.info.coverImage;
            }
        }

        return (
            <TouchableOpacity
                style={styles.listRow}
                onPress={() => isFolder ? handleFolderPress(data) : handleAlbumPress(data)}
            >
                <View style={styles.coverContainer}>
                    {isFolder ? (
                        <View style={[styles.placeholderCover, { backgroundColor: isFaces ? '#F0F5FF' : '#F5F5F5' }]}>
                            {isFaces ? <Users color="#007AFF" size={28} strokeWidth={1.5} /> : <Folder color="#8E8E93" size={28} strokeWidth={1.5} />}
                        </View>
                    ) : (
                        coverUri ? (
                            <Image 
                                source={{ uri: coverUri }} 
                                style={styles.coverImage} 
                                contentFit="cover" 
                                cachePolicy="memory-disk" 
                            />
                        ) : (
                            <View style={[styles.placeholderCover, { backgroundColor: '#F5F5F5' }]}>
                                <ImageIcon color="#8E8E93" size={28} strokeWidth={1.5} />
                            </View>
                        )
                    )}
                </View>
                <View style={styles.infoContainer}>
                    <Text style={styles.titleText} numberOfLines={1}>{data.name}</Text>
                    {count > 0 && <Text style={styles.subtitleText}>{count} items</Text>}
                </View>
            </TouchableOpacity>
        );
    };

    const items = collection ? collection.getItems() : [];

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>Albums</Text>
            </View>
            {loading && items.length === 0 ? (
                <View style={styles.centerContainer}>
                    <ActivityIndicator size="large" color="#007AFF" />
                </View>
            ) : (
                <FlashList
                    data={items}
                    keyExtractor={(item) => item.key}
                    renderItem={renderItem}
                    estimatedItemSize={76}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Folder color="#D1D1D6" size={60} strokeWidth={1.5} />
                            <Text style={styles.emptyText}>No albums found</Text>
                        </View>
                    }
                    refreshing={loading}
                    onRefresh={loadAlbums}
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
        justifyContent: 'center',
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
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#fff',
    },
    listContent: {
        paddingBottom: 40,
    },
    listRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING,
        paddingVertical: 12,
        backgroundColor: '#fff',
    },
    coverContainer: {
        width: 60,
        height: 60,
        borderRadius: 12,
        backgroundColor: '#f5f5f5',
        overflow: 'hidden',
        marginRight: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
    },
    coverImage: {
        width: '100%',
        height: '100%',
    },
    placeholderCover: {
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    infoContainer: {
        flex: 1,
        justifyContent: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#E5E5EA',
        paddingBottom: 16,
        paddingTop: 4,
    },
    titleText: {
        fontSize: 17,
        fontWeight: '600',
        color: '#1A1A1A',
        marginBottom: 4,
    },
    subtitleText: {
        fontSize: 14,
        color: '#8E8E93',
    },
    emptyContainer: {
        alignItems: 'center',
        marginTop: 100,
    },
    emptyText: {
        fontSize: 16,
        color: '#999',
        marginTop: 16,
    }
});
