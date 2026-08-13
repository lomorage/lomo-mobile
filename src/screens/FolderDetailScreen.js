import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, DeviceEventEmitter, Alert, Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { Folder, Users, Image as ImageIcon, CheckCircle, Circle, Trash2, Combine } from 'lucide-react-native';

const { width } = Dimensions.get('window');
import RemoteAlbumService from '../services/RemoteAlbumService';
import { buildImageDataUri } from '../utils/base64Image';

// Memoized so that selecting one face card doesn't force every other visible
// card to re-render. Without this, changing `selectedIds` re-runs the whole
// FlashList's renderItem, which used to rebuild a brand-new `source={{uri}}`
// object per card on every keystroke of selection -- expo-image sees a
// "new" source (different object identity, same content) and restarts the
// decode for every visible card, and rapid taps were queuing up enough
// redundant reloads to leave some cards permanently blank (confirmed via
// device logs: the same cover firing onLoadStart 4x within ~2s from taps
// alone, with no image content change).
const FaceCard = React.memo(function FaceCard({ album, isSelected, selectionMode, itemWidth, onPress, onLongPress }) {
    const coverSource = useMemo(() => {
        const uri = buildImageDataUri(album.info.coverImage);
        return uri ? { uri } : null;
    }, [album.info.coverImage]);

    return (
        <TouchableOpacity
            style={[styles.faceCard, { width: itemWidth }]}
            onPress={() => onPress(album)}
            onLongPress={() => onLongPress(album)}
            delayLongPress={500}
        >
            {/* borderWidth is always 3 (never 0) and only borderColor toggles --
                changing the container's box size when selection toggles was
                forcing the native image layer to treat the cover as needing a
                fresh decode at a new target size, which is what was leaving
                cards blank after select-then-deselect. Keeping the box size
                constant avoids that entirely. */}
            <View style={[styles.faceCoverContainer, { width: itemWidth, height: itemWidth, borderRadius: itemWidth / 2, borderWidth: 3, borderColor: isSelected ? '#007AFF' : 'transparent' }]}>
                {coverSource ? (
                    <Image
                        source={coverSource}
                        style={styles.coverImage}
                        contentFit="cover"
                        // Covers are base64 data: URIs embedded directly in the /album
                        // response, not fetched over the network -- disk-caching them
                        // (memory-disk) has no benefit and was intermittently leaving
                        // some covers stuck blank. Memory-only cache is enough to avoid
                        // re-decoding the same string on every re-render.
                        cachePolicy="memory"
                        recyclingKey={String(album.info.id)}
                    />
                ) : (
                    <View style={[styles.placeholderCover, { backgroundColor: '#F0F5FF' }]}>
                        <Users color="#007AFF" size={32} strokeWidth={1.5} />
                    </View>
                )}
                {selectionMode && (
                    <View style={styles.selectionBadge}>
                        {isSelected
                            ? <CheckCircle color="#4DA3FF" size={22} strokeWidth={2.5} />
                            : <Circle color="#fff" size={22} strokeWidth={2} />}
                    </View>
                )}
            </View>
            <Text style={styles.faceTitle} numberOfLines={1}>{album.name}</Text>
        </TouchableOpacity>
    );
});

// Same rationale as FaceCard: keeps the cover Image's source object identity
// stable across unrelated re-renders of the parent list.
const AlbumRow = React.memo(function AlbumRow({ album, onPress }) {
    const coverSource = useMemo(() => {
        const uri = buildImageDataUri(album.info.coverImage);
        return uri ? { uri } : null;
    }, [album.info.coverImage]);
    const count = album.info && album.info.count ? album.info.count : 0;

    return (
        <TouchableOpacity style={styles.listRow} onPress={() => onPress(album)}>
            <View style={styles.listCoverContainer}>
                {coverSource ? (
                    <Image source={coverSource} style={styles.coverImage} contentFit="cover" cachePolicy="memory" recyclingKey={String(album.info.id)} />
                ) : (
                    <View style={[styles.placeholderCover, { backgroundColor: '#F5F5F5' }]}>
                        <ImageIcon color="#8E8E93" size={28} strokeWidth={1.5} />
                    </View>
                )}
            </View>
            <View style={styles.infoContainer}>
                <Text style={styles.titleText} numberOfLines={1}>{album.name}</Text>
                {count > 0 && <Text style={styles.subtitleText}>{count} items</Text>}
            </View>
        </TouchableOpacity>
    );
});

export default function FolderDetailScreen() {
    const route = useRoute();
    const navigation = useNavigation();
    
    const { folderName, folderPath } = route.params;
    const [items, setItems] = useState([]);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [mergePrompt, setMergePrompt] = useState({ visible: false, text: '' });
    const [busy, setBusy] = useState(false);

    const isFacesFolder = folderName === 'Faces' || folderPath.includes('/Faces');
    const SPACING = 16;
    const NUM_COLUMNS = isFacesFolder ? 3 : 1;
    const FACE_ITEM_WIDTH = (width - SPACING * 4) / 3;

    const loadFolderItems = useCallback(() => {
        const root = RemoteAlbumService.getRootCollection();
        if (root) {
            const collection = root.getCollectionByPath(folderPath);
            if (collection) {
                setItems(collection.getItems());
            }
        }
    }, [folderPath]);

    useEffect(() => {
        loadFolderItems();

        const sub1 = DeviceEventEmitter.addListener('albumDeleted', () => {
            loadFolderItems();
        });
        const sub2 = DeviceEventEmitter.addListener('albumRenamed', () => {
            loadFolderItems();
        });

        return () => {
            sub1.remove();
            sub2.remove();
        };
    }, [loadFolderItems]);

    // Stable (empty deps -- uses the functional setState form) so it never
    // forces handleAlbumPress/handleAlbumLongPress to change identity.
    const toggleSelected = useCallback((albumId) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            const key = String(albumId);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const handleAlbumPress = useCallback((album) => {
        if (selectionMode) {
            toggleSelected(album.info.id);
            return;
        }
        navigation.push('AlbumDetail', { albumId: album.info.id, albumName: album.name, fullPath: album.info.name });
    }, [selectionMode, navigation, toggleSelected]);

    const handleAlbumLongPress = useCallback((album) => {
        if (!isFacesFolder) return;
        setSelectionMode(true);
        toggleSelected(album.info.id);
    }, [isFacesFolder, toggleSelected]);

    const cancelSelection = () => {
        setSelectionMode(false);
        setSelectedIds(new Set());
    };

    const confirmBatchDelete = () => {
        const count = selectedIds.size;
        if (count === 0) return;
        Alert.alert(
            'Delete People',
            `Delete ${count} ${count === 1 ? 'person' : 'people'}? This will not delete the photos inside.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        setBusy(true);
                        try {
                            const ids = Array.from(selectedIds);
                            const ok = await RemoteAlbumService.deleteAlbums(ids);
                            if (ok) {
                                ids.forEach(id => RemoteAlbumService.deleteAlbumFromTree(id));
                                DeviceEventEmitter.emit('albumDeleted');
                                cancelSelection();
                            } else {
                                Alert.alert('Delete Failed', 'Could not delete the selected people. Please try again.');
                            }
                        } finally {
                            setBusy(false);
                        }
                    }
                }
            ]
        );
    };

    const openMergePrompt = () => {
        if (selectedIds.size < 2) return;
        // Default the merged name to whichever selected person currently has the
        // most photos, matching which one the server will keep as the survivor.
        const selectedAlbums = items
            .filter(item => item.type === 'album' && selectedIds.has(String(item.data.info.id)));
        let defaultName = '';
        let maxCount = -1;
        for (const item of selectedAlbums) {
            const count = item.data.info.count || 0;
            const name = item.data.name && item.data.name.startsWith('unamed-') ? '' : item.data.name;
            if (count > maxCount && name) {
                maxCount = count;
                defaultName = name;
            }
        }
        setMergePrompt({ visible: true, text: defaultName });
    };

    const handleMergeSubmit = async () => {
        const title = mergePrompt.text.trim();
        setMergePrompt({ visible: false, text: '' });
        if (!title) return;

        setBusy(true);
        try {
            const ids = Array.from(selectedIds);
            const ok = await RemoteAlbumService.mergeAlbums(ids, title);
            if (ok) {
                await RemoteAlbumService.getAlbumsHierarchy({ priority: 1, groupId: 'Albums' });
                loadFolderItems();
                DeviceEventEmitter.emit('albumDeleted');
                cancelSelection();
            } else {
                Alert.alert('Merge Failed', 'Could not merge the selected people. Please try again.');
            }
        } finally {
            setBusy(false);
        }
    };

    const handleFolderPress = useCallback((folder) => {
        navigation.push('FolderDetail', { folderPath: folder.fullPath, folderName: folder.name, fullPath: folder.fullPath });
    }, [navigation]);

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

            if (isFacesFolder) {
                const isSelected = selectedIds.has(String(album.info.id));
                return (
                    <FaceCard
                        album={album}
                        isSelected={isSelected}
                        selectionMode={selectionMode}
                        itemWidth={FACE_ITEM_WIDTH}
                        onPress={handleAlbumPress}
                        onLongPress={handleAlbumLongPress}
                    />
                );
            }

            return <AlbumRow album={album} onPress={handleAlbumPress} />;
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {selectionMode ? (
                    <TouchableOpacity onPress={cancelSelection} style={styles.cancelButton}>
                        <Text style={styles.headerActionText} numberOfLines={1}>Cancel</Text>
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity onPress={() => navigation.canGoBack() && navigation.goBack()} style={styles.iconButton}>
                        <Text style={{fontSize: 24, paddingHorizontal: 10}}>‹</Text>
                    </TouchableOpacity>
                )}
                <Text style={styles.title} numberOfLines={1}>
                    {selectionMode ? `${selectedIds.size} Selected` : folderName}
                </Text>
                <View style={{ width: 44 }} />
            </View>
                <FlashList
                    data={items}
                    keyExtractor={(item) => item.key}
                    renderItem={renderItem}
                    estimatedItemSize={isFacesFolder ? FACE_ITEM_WIDTH + 40 : 76}
                    numColumns={NUM_COLUMNS}
                    contentContainerStyle={[styles.listContent, isFacesFolder && { paddingHorizontal: SPACING }, selectionMode && { paddingBottom: 90 }]}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Folder color="#D1D1D6" size={60} strokeWidth={1.5} />
                            <Text style={styles.emptyText}>Empty Folder</Text>
                        </View>
                    }
                />

            {selectionMode && (
                <View style={styles.selectionToolbar}>
                    <TouchableOpacity
                        style={[styles.toolbarButton, selectedIds.size < 2 && styles.toolbarButtonDisabled]}
                        onPress={openMergePrompt}
                        disabled={selectedIds.size < 2 || busy}
                    >
                        <Combine color={selectedIds.size < 2 ? '#C7C7CC' : '#007AFF'} size={22} />
                        <Text style={[styles.toolbarButtonText, selectedIds.size < 2 && styles.toolbarButtonTextDisabled]}>Merge</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.toolbarButton, selectedIds.size === 0 && styles.toolbarButtonDisabled]}
                        onPress={confirmBatchDelete}
                        disabled={selectedIds.size === 0 || busy}
                    >
                        <Trash2 color={selectedIds.size === 0 ? '#C7C7CC' : '#FF3B30'} size={22} />
                        <Text style={[styles.toolbarButtonText, styles.toolbarButtonTextDestructive, selectedIds.size === 0 && styles.toolbarButtonTextDisabled]}>Delete</Text>
                    </TouchableOpacity>
                </View>
            )}

            {busy && (
                <View style={styles.busyOverlay}>
                    <ActivityIndicator size="large" color="#fff" />
                </View>
            )}

            <Modal
                visible={mergePrompt.visible}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setMergePrompt({ visible: false, text: '' })}
            >
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.modalOverlay}
                >
                    <View style={styles.promptContainer}>
                        <Text style={styles.promptTitle}>Merge {selectedIds.size} People</Text>
                        <Text style={styles.promptSubtitle}>All their photos will be combined into one person.</Text>
                        <TextInput
                            style={styles.promptInput}
                            value={mergePrompt.text}
                            onChangeText={t => setMergePrompt(prev => ({ ...prev, text: t }))}
                            placeholder="Name"
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={handleMergeSubmit}
                        />
                        <View style={styles.promptActions}>
                            <TouchableOpacity style={styles.promptBtn} onPress={() => setMergePrompt({ visible: false, text: '' })}>
                                <Text style={styles.promptBtnCancel}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.promptBtn} onPress={handleMergeSubmit}>
                                <Text style={styles.promptBtnSubmit}>Merge</Text>
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
    cancelButton: {
        padding: 5,
        paddingHorizontal: 8,
        minWidth: 44,
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
    },
    headerActionText: {
        fontSize: 17,
        color: '#007AFF',
        paddingHorizontal: 10,
    },
    selectionBadge: {
        position: 'absolute',
        top: 4,
        right: 4,
        borderRadius: 11,
        backgroundColor: 'rgba(0,0,0,0.25)',
    },
    selectionToolbar: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        justifyContent: 'space-around',
        backgroundColor: '#fff',
        paddingVertical: 10,
        paddingBottom: Platform.OS === 'ios' ? 28 : 10,
        borderTopWidth: 1,
        borderTopColor: '#eee',
    },
    toolbarButton: {
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 4,
    },
    toolbarButtonDisabled: {
        opacity: 0.5,
    },
    toolbarButtonText: {
        fontSize: 12,
        color: '#007AFF',
        marginTop: 2,
    },
    toolbarButtonTextDestructive: {
        color: '#FF3B30',
    },
    toolbarButtonTextDisabled: {
        color: '#C7C7CC',
    },
    busyOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.25)',
        justifyContent: 'center',
        alignItems: 'center',
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
        marginBottom: 6,
        color: '#333',
        textAlign: 'center',
    },
    promptSubtitle: {
        fontSize: 13,
        color: '#8E8E93',
        marginBottom: 16,
        textAlign: 'center',
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
