import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ChevronLeft, Trash2, CheckCircle2, Circle, X } from 'lucide-react-native';
import AssetDBService from '../services/AssetDBService';
import MediaService from '../services/MediaService';
import AuthService from '../services/AuthService';
import GalleryStore from '../store/GalleryStore';

export default function FreeUpSpaceScreen({ navigation }) {
    const [videos, setVideos] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const [previewVideoUri, setPreviewVideoUri] = useState(null);

    useEffect(() => {
        loadVideos();
    }, []);

    const loadVideos = async () => {
        setLoading(true);
        try {
            const rows = await AssetDBService.getSafelyBackedUpVideos();
            
            // Limit to top 200 for performance on initial load if needed, but size fetch is the real bottleneck.
            // We will fetch sizes for the first 100 to show quickly.
            const candidates = rows.slice(0, 100);
            
            const withSizes = await Promise.all(candidates.map(async (asset) => {
                const sizeBytes = await MediaService.getAssetSize(asset.id);
                const localUri = Platform.OS === 'android'
                    ? `content://media/external/video/media/${asset.id}/thumbnail`
                    : `ph://${asset.id}`;
                return {
                    ...asset,
                    sizeBytes,
                    uri: localUri
                };
            }));

            // Sort by size descending
            const sorted = withSizes.sort((a, b) => b.sizeBytes - a.sizeBytes);
            setVideos(sorted);
        } catch (e) {
            console.error('[FreeUpSpaceScreen] Error loading videos:', e);
        } finally {
            setLoading(false);
        }
    };

    const toggleSelection = useCallback((id) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(id)) newSet.delete(id);
            else newSet.add(id);
            return newSet;
        });
    }, []);

    const formatSize = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const totalSelectedSize = useMemo(() => {
        let total = 0;
        videos.forEach(v => {
            if (selectedIds.has(v.id)) total += v.sizeBytes;
        });
        return total;
    }, [selectedIds, videos]);

    const handleDelete = () => {
        if (selectedIds.size === 0) return;
        
        Alert.alert(
            "Delete from Device",
            `Are you sure you want to delete ${selectedIds.size} videos? They are securely backed up on your Lomorage server.\n\nThis will free up ${formatSize(totalSelectedSize)}.`,
            [
                { text: "Cancel", style: "cancel" },
                { 
                    text: "Delete", 
                    style: "destructive",
                    onPress: async () => {
                        setIsDeleting(true);
                        try {
                            const idsToDelete = Array.from(selectedIds);
                            // Delete natively
                            await MediaService.deleteLocalAssets(idsToDelete);
                            
                            // Immediately remove from SQLite tracking
                            const db = AssetDBService.db;
                            if (db) {
                                for (const id of idsToDelete) {
                                    await db.runAsync('UPDATE MediaAsset SET isLocal = 0 WHERE id = ?', [id]);
                                }
                            }
                            
                            // Remove from local state
                            setVideos(prev => prev.filter(v => !selectedIds.has(v.id)));
                            setSelectedIds(new Set());
                            
                            Alert.alert("Success", "Successfully freed up space!");
                        } catch (e) {
                            Alert.alert("Error", e.message || "Failed to delete files.");
                        } finally {
                            setIsDeleting(false);
                        }
                    }
                }
            ]
        );
    };

    const playVideo = async (item) => {
        try {
            const info = await MediaService.getAssetInfo(item.id);
            const playableUri = info?.localUri || info?.uri;
            if (playableUri) {
                setPreviewVideoUri(playableUri);
            } else {
                Alert.alert('Error', 'Unable to play local video.');
            }
        } catch (e) {
            console.error('[FreeUpSpaceScreen] Error preparing video preview:', e);
            Alert.alert('Error', 'Unable to play local video.');
        }
    };

    const renderItem = ({ item }) => {
        const isSelected = selectedIds.has(item.id);
        
        return (
            <TouchableOpacity 
                style={styles.card}
                activeOpacity={0.8}
                onPress={() => playVideo(item)}
            >
                <Image 
                    source={{ uri: item.uri }} 
                    style={styles.thumbnail}
                    contentFit="cover"
                />
                <View style={styles.overlay}>
                    <View style={styles.sizeBadge}>
                        <Text style={styles.sizeText}>{formatSize(item.sizeBytes)}</Text>
                    </View>
                </View>
                <TouchableOpacity 
                    style={styles.checkCircle}
                    activeOpacity={0.8}
                    onPress={(e) => {
                        e.stopPropagation();
                        toggleSelection(item.id);
                    }}
                >
                    {isSelected ? (
                        <CheckCircle2 size={24} color="#007AFF" fill="#fff" />
                    ) : (
                        <Circle size={24} color="rgba(255,255,255,0.8)" />
                    )}
                </TouchableOpacity>
            </TouchableOpacity>
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <ChevronLeft size={28} color="#007AFF" />
                    <Text style={styles.backText}>Settings</Text>
                </TouchableOpacity>
                <Text style={styles.title}>Free Up Space</Text>
            </View>

            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="large" color="#007AFF" />
                    <Text style={styles.loadingText}>Scanning safely backed up large files...</Text>
                </View>
            ) : videos.length === 0 ? (
                <View style={styles.centered}>
                    <Text style={styles.emptyText}>No large backed-up files found.</Text>
                </View>
            ) : (
                <View style={styles.listContainer}>
                    <FlashList
                        data={videos}
                        renderItem={renderItem}
                        keyExtractor={item => item.id}
                        numColumns={3}
                        estimatedItemSize={120}
                        extraData={selectedIds}
                    />
                </View>
            )}

            <View style={styles.footer}>
                <View style={styles.footerInfo}>
                    <Text style={styles.footerText}>Selected: {selectedIds.size}</Text>
                    <Text style={styles.footerSize}>{formatSize(totalSelectedSize)}</Text>
                </View>
                <TouchableOpacity 
                    style={[styles.deleteButton, selectedIds.size === 0 && styles.deleteButtonDisabled]}
                    onPress={handleDelete}
                    disabled={selectedIds.size === 0 || isDeleting}
                >
                    {isDeleting ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <>
                            <Trash2 size={20} color="#fff" />
                            <Text style={styles.deleteButtonText}>Delete</Text>
                        </>
                    )}
                </TouchableOpacity>
            </View>
            {previewVideoUri && (
                <VideoPreviewModal 
                    uri={previewVideoUri} 
                    onClose={() => setPreviewVideoUri(null)} 
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
        paddingTop: 50,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        position: 'absolute',
        bottom: 10,
        left: 0,
        zIndex: 10,
    },
    backText: {
        color: '#007AFF',
        fontSize: 17,
    },
    title: {
        flex: 1,
        textAlign: 'center',
        fontSize: 17,
        fontWeight: '600',
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    loadingText: {
        marginTop: 10,
        color: '#666',
    },
    emptyText: {
        fontSize: 16,
        color: '#666',
        textAlign: 'center',
    },
    listContainer: {
        flex: 1,
    },
    card: {
        flex: 1,
        aspectRatio: 1,
        margin: 1,
        position: 'relative',
    },
    thumbnail: {
        width: '100%',
        height: '100%',
        backgroundColor: '#f0f0f0',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        padding: 4,
    },
    sizeBadge: {
        backgroundColor: 'rgba(0,0,0,0.6)',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        alignSelf: 'flex-start',
    },
    sizeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: 'bold',
    },
    checkCircle: {
        position: 'absolute',
        top: 6,
        right: 6,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        paddingBottom: 30,
        backgroundColor: '#f8f8f8',
        borderTopWidth: 1,
        borderTopColor: '#eee',
    },
    footerInfo: {
        flex: 1,
    },
    footerText: {
        fontSize: 14,
        color: '#666',
    },
    footerSize: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#1a1a1a',
    },
    deleteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FF3B30',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 24,
    },
    deleteButtonDisabled: {
        backgroundColor: '#ffb3b0',
    },
    deleteButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
    modalContainer: {
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeButton: {
        position: 'absolute',
        top: 50,
        right: 20,
        zIndex: 10,
        padding: 10,
    },
    modalVideo: {
        width: '100%',
        height: '80%',
    },
});

function VideoPreviewModal({ uri, onClose }) {
    const player = useVideoPlayer(uri, player => {
        player.loop = true;
        player.play();
    });

    return (
        <Modal 
            visible={true} 
            animationType="slide" 
            onRequestClose={onClose}
        >
            <View style={styles.modalContainer}>
                <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                    <X size={30} color="#fff" />
                </TouchableOpacity>
                <VideoView 
                    player={player} 
                    style={styles.modalVideo} 
                    nativeControls={true}
                    allowsFullscreen={true}
                />
            </View>
        </Modal>
    );
}
