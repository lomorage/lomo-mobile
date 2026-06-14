import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { Folder, Users, Image as ImageIcon } from 'lucide-react-native';

const { width } = Dimensions.get('window');
import RemoteAlbumService from '../services/RemoteAlbumService';

export default function FolderDetailScreen() {
    const route = useRoute();
    const navigation = useNavigation();
    
    const { folderName, folderPath } = route.params;
    const [items, setItems] = useState([]);

    const isFacesFolder = folderName === 'Faces' || folderPath.includes('/Faces');
    const SPACING = 16;
    const NUM_COLUMNS = isFacesFolder ? 3 : 1;
    const FACE_ITEM_WIDTH = (width - SPACING * 4) / 3;

    useEffect(() => {
        const root = RemoteAlbumService.getRootCollection();
        if (root) {
            const collection = root.getCollectionByPath(folderPath);
            if (collection) {
                setItems(collection.getItems());
            }
        }
    }, [folderPath]);

    const handleAlbumPress = (album) => {
        navigation.push('AlbumDetail', { albumId: album.info.id, albumName: album.name });
    };

    const handleFolderPress = (folder) => {
        navigation.push('FolderDetail', { folderPath: folder.fullPath, folderName: folder.name });
    };

    const renderItem = ({ item }) => {
        if (item.type === 'folder') {
            const folder = item.data;
            const isFaces = folder.name === 'Faces' || folder.fullPath.includes('/Faces');
            
            if (isFacesFolder) return null;

            return (
                <TouchableOpacity style={styles.listRow} onPress={() => handleFolderPress(folder)}>
                    <View style={styles.listCoverContainer}>
                        <View style={[styles.placeholderCover, { backgroundColor: isFaces ? '#F0F5FF' : '#F5F5F5' }]}>
                            {isFaces ? <Users color="#007AFF" size={28} strokeWidth={1.5} /> : <Folder color="#8E8E93" size={28} strokeWidth={1.5} />}
                        </View>
                    </View>
                    <View style={styles.infoContainer}>
                        <Text style={styles.titleText} numberOfLines={1}>{folder.name}</Text>
                        <Text style={styles.subtitleText}>{folder.children ? folder.children.length : 0} items</Text>
                    </View>
                </TouchableOpacity>
            );
        } else {
            const album = item.data;
            let coverSource = null;
            if (album.info.coverImage) {
                const base64Prefix = 'data:image/jpeg;base64,';
                const uri = album.info.coverImage.startsWith('data:') ? album.info.coverImage : base64Prefix + album.info.coverImage;
                coverSource = { uri };
            }

            if (isFacesFolder) {
                return (
                    <TouchableOpacity style={[styles.faceCard, { width: FACE_ITEM_WIDTH }]} onPress={() => handleAlbumPress(album)}>
                        <View style={[styles.faceCoverContainer, { width: FACE_ITEM_WIDTH, height: FACE_ITEM_WIDTH, borderRadius: FACE_ITEM_WIDTH / 2 }]}>
                            {coverSource ? (
                                <Image source={coverSource} style={styles.coverImage} contentFit="cover" cachePolicy="memory-disk" />
                            ) : (
                                <View style={[styles.placeholderCover, { backgroundColor: '#F0F5FF' }]}>
                                    <Users color="#007AFF" size={32} strokeWidth={1.5} />
                                </View>
                            )}
                        </View>
                        <Text style={styles.faceTitle} numberOfLines={1}>{album.name}</Text>
                    </TouchableOpacity>
                );
            }

            return (
                <TouchableOpacity style={styles.listRow} onPress={() => handleAlbumPress(album)}>
                    <View style={styles.listCoverContainer}>
                        {coverSource ? (
                            <Image source={coverSource} style={styles.coverImage} contentFit="cover" cachePolicy="memory-disk" />
                        ) : (
                            <View style={[styles.placeholderCover, { backgroundColor: '#F5F5F5' }]}>
                                <ImageIcon color="#8E8E93" size={28} strokeWidth={1.5} />
                            </View>
                        )}
                    </View>
                    <View style={styles.infoContainer}>
                        <Text style={styles.titleText} numberOfLines={1}>{album.name}</Text>
                        <Text style={styles.subtitleText}>Album</Text>
                    </View>
                </TouchableOpacity>
            );
        }
    };



    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.canGoBack() && navigation.goBack()} style={styles.iconButton}>
                    <Text style={{fontSize: 24, paddingHorizontal: 10}}>‹</Text>
                </TouchableOpacity>
                <Text style={styles.title} numberOfLines={1}>{folderName}</Text>
                <View style={{ width: 44 }} />
            </View>
                <FlashList
                    data={items}
                    keyExtractor={(item) => item.key}
                    renderItem={renderItem}
                    estimatedItemSize={isFacesFolder ? FACE_ITEM_WIDTH + 40 : 76}
                    numColumns={NUM_COLUMNS}
                    contentContainerStyle={[styles.listContent, isFacesFolder && { paddingHorizontal: SPACING }]}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Folder color="#D1D1D6" size={60} strokeWidth={1.5} />
                            <Text style={styles.emptyText}>Empty Folder</Text>
                        </View>
                    }
                />
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
    iconButton: {
        padding: 5,
        width: 44,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1a1a1a',
        flex: 1,
        textAlign: 'center',
    },
    listContent: {
        paddingBottom: 40,
    },
    listRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: '#fff',
    },
    listCoverContainer: {
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
    faceCard: {
        marginBottom: 24,
        alignItems: 'center',
        marginHorizontal: 8,
    },
    faceCoverContainer: {
        backgroundColor: '#f5f5f5',
        overflow: 'hidden',
        marginBottom: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 2,
    },
    faceTitle: {
        fontSize: 14,
        fontWeight: '500',
        color: '#1A1A1A',
        textAlign: 'center',
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
