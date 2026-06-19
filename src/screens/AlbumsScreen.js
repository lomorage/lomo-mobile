import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Dimensions, Alert, Modal, TextInput, KeyboardAvoidingView, Platform, DeviceEventEmitter } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { Folder, Users, Image as ImageIcon, Plus, Copy } from 'lucide-react-native';
import RemoteAlbumService from '../services/RemoteAlbumService';
import NetworkQueue from '../services/NetworkQueue';

const { width } = Dimensions.get('window');
const SPACING = 16;

export default function AlbumsScreen() {
    const [collection, setCollection] = useState(null);
    const [loading, setLoading] = useState(true);
    const [promptState, setPromptState] = useState({ visible: false, action: 'create', albumId: null, text: '' });
    const navigation = useNavigation();

    useEffect(() => {
        loadAlbums();
    }, []);

    useFocusEffect(
        React.useCallback(() => {
            // Clean up: when user leaves Albums tab, abort any pending Album requests
            return () => {
                NetworkQueue.cancelGroup('Albums');
            };
        }, [])
    );

    useEffect(() => {
        const sub1 = DeviceEventEmitter.addListener('albumDeleted', () => {
            const root = RemoteAlbumService.getRootCollection();
            if (root) {
                setCollection(Object.assign(Object.create(Object.getPrototypeOf(root)), root));
            }
        });
        const sub2 = DeviceEventEmitter.addListener('albumRenamed', () => {
            const root = RemoteAlbumService.getRootCollection();
            if (root) {
                setCollection(Object.assign(Object.create(Object.getPrototypeOf(root)), root));
            }
        });
        return () => {
            sub1.remove();
            sub2.remove();
        };
    }, []);

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
        navigation.navigate('AlbumDetail', { albumId: album.info.id, albumName: album.name, fullPath: album.info.name });
    };

    const handleAlbumLongPress = (album) => {
        // Prevent editing system albums or folders for now
        if (!album.info || !album.info.id || album.name.startsWith('/')) return;
        
        Alert.alert(
            'Album Options',
            `What would you like to do with "${album.name}"?`,
            [
                { text: 'Rename', onPress: () => setPromptState({ visible: true, action: 'rename', albumId: album.info.id, text: album.name, fullPath: album.info.name }) },
                { text: 'Delete', style: 'destructive', onPress: () => confirmDeleteAlbum(album) },
                { text: 'Cancel', style: 'cancel' }
            ]
        );
    };

    const confirmDeleteAlbum = (album) => {
        Alert.alert(
            'Delete Album',
            `Are you sure you want to delete "${album.name}"? This will not delete the photos inside.`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: async () => {
                    RemoteAlbumService.deleteAlbumFromTree(album.info.id);
                    DeviceEventEmitter.emit('albumDeleted', album.info.id);
                    await RemoteAlbumService.deleteAlbum(album.info.id);
                }}
            ]
        );
    };

    const handlePromptSubmit = async () => {
        const { action, albumId, text } = promptState;
        if (!text.trim()) {
            setPromptState({ visible: false, action: 'create', albumId: null, text: '', fullPath: '' });
            return;
        }
        
        setPromptState(prev => ({ ...prev, visible: false }));
        
        if (action === 'create') {
            setLoading(true);
            await RemoteAlbumService.createAlbum(text.trim());
            loadAlbums();
        } else if (action === 'rename' && albumId) {
            let newFullPath = text.trim();
            if (promptState.fullPath && promptState.fullPath.includes('/')) {
                const parts = promptState.fullPath.split('/');
                // Handle cases where fullPath ends with '/'
                if (parts[parts.length - 1] === '') {
                    parts.pop();
                }
                parts[parts.length - 1] = newFullPath;
                newFullPath = parts.join('/');
            }

            RemoteAlbumService.renameAlbumInTree(albumId, text.trim(), newFullPath);
            DeviceEventEmitter.emit('albumRenamed', { albumId, newName: text.trim(), newFullPath });
            await RemoteAlbumService.updateAlbumInfo(albumId, newFullPath);
        }
    };

    const handleFolderPress = (folder) => {
        navigation.navigate('FolderDetail', { folderPath: folder.fullPath, folderName: folder.name });
    };

    const renderItem = ({ item }) => {
        if (item.type === 'smart-album') {
            return (
                <TouchableOpacity
                    style={styles.listRow}
                    onPress={() => navigation.navigate('Duplicates')}
                >
                    <View style={styles.coverContainer}>
                        <View style={[styles.placeholderCover, { backgroundColor: '#FFF2E0' }]}>
                            <Copy color="#FF9500" size={28} strokeWidth={1.5} />
                        </View>
                    </View>
                    <View style={styles.infoContainer}>
                        <Text style={styles.titleText} numberOfLines={1}>{item.data.name}</Text>
                        <Text style={styles.subtitleText}>Smart Album</Text>
                    </View>
                </TouchableOpacity>
            );
        }

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
                onLongPress={() => isFolder ? null : handleAlbumLongPress(data)}
                delayLongPress={500}
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

    const rawItems = collection ? collection.getItems() : [];
    const items = [
        {
            key: 'smart-duplicates',
            type: 'smart-album',
            data: {
                name: 'Duplicates Cleanup',
            }
        },
        ...rawItems
    ];

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.headerLeft} />
                <Text style={styles.title}>Albums</Text>
                <TouchableOpacity 
                    style={styles.headerRight} 
                    onPress={() => setPromptState({ visible: true, action: 'create', albumId: null, text: '' })}
                >
                    <Plus color="#007AFF" size={24} />
                </TouchableOpacity>
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

            <Modal
                visible={promptState.visible}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setPromptState(prev => ({ ...prev, visible: false }))}
            >
                <KeyboardAvoidingView 
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.modalOverlay}
                >
                    <View style={styles.promptContainer}>
                        <Text style={styles.promptTitle}>{promptState.action === 'create' ? 'New Album' : 'Rename Album'}</Text>
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
                            <TouchableOpacity style={styles.promptBtn} onPress={() => setPromptState(prev => ({ ...prev, visible: false }))}>
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
    headerLeft: {
        width: 32, // to balance the plus icon on the right
    },
    headerRight: {
        width: 32,
        alignItems: 'flex-end',
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
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
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
    }
});
