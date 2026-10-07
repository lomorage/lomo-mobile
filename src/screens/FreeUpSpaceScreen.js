import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ChevronLeft, Trash2, CheckCircle2, Circle, X } from 'lucide-react-native';
import AssetDBService from '../services/AssetDBService';
import BackupSafetyService from '../services/BackupSafetyService';
import { ANDROID_DELETE_CHUNK, buildDeleteConfirmation, deleteInChunks, isVerificationStale } from './freeUpSpaceHelpers';
import MediaService from '../services/MediaService';
import { describeCounts, summarizeBackup } from '../utils/backupSummary';
import { formatBytesLog } from '../utils/formatters';
import { useServerEpoch } from '../hooks/useServerEpoch';
import { useImageRetry, withRetryBuster } from '../hooks/useImageRetry';

const SIZE_BACKFILL_CONCURRENCY = 4;
const SIZE_FLUSH_EVERY = 50;

const TABS = [
    { key: 'video', label: 'Videos' },
    { key: 'photo', label: 'Photos' },
];

const localUriFor = (asset) => {
    if (Platform.OS !== 'android') return `ph://${asset.id}`;
    return asset.mediaType === 'video'
        ? `content://media/external/video/media/${asset.id}`
        : `content://media/external/images/media/${asset.id}`;
};

// Largest first; items whose size is still being measured go last.
const sortVideos = (videos) => [...videos].sort((a, b) => b.sizeBytes - a.sizeBytes);

export default function FreeUpSpaceScreen({ navigation }) {
    const serverEpoch = useServerEpoch();
    const [tab, setTab] = useState('video');
    const [itemsByType, setItemsByType] = useState({ video: [], photo: [] });
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const [verifyProgress, setVerifyProgress] = useState(null); // { done, total } while checking
    const [previewVideoUri, setPreviewVideoUri] = useState(null);
    const mounted = useRef(true);

    const loadSummary = useCallback(async () => {
        const rows = await AssetDBService.getBackupSummaryRows();
        if (mounted.current) setSummary(summarizeBackup(rows));
    }, []);

    useEffect(() => {
        mounted.current = true;
        load();
        return () => { mounted.current = false; };
    }, []);

    const load = async () => {
        setLoading(true);
        try {
            const [videos, photos] = await Promise.all([
                AssetDBService.getFreeUpSpaceCandidates('video'),
                AssetDBService.getFreeUpSpaceCandidates('photo'),
            ]);
            await loadSummary();
            if (!mounted.current) return;
            const toItem = (asset) => ({ ...asset, sizeBytes: asset.fileSize || 0, uri: localUriFor(asset) });
            setItemsByType({ video: sortVideos(videos.map(toItem)), photo: photos.map(toItem) });
            setLoading(false);
            backfillSizes([...videos, ...photos].filter(asset => !asset.fileSize));
        } catch (e) {
            console.error('[FreeUpSpaceScreen] Error loading backed-up items:', e);
            if (mounted.current) setLoading(false);
        }
    };

    // Items backed up before sizes were recorded: ask the OS once and remember it.
    const backfillSizes = async (assets) => {
        if (assets.length === 0) return;
        let next = 0;
        let pending = [];
        const flush = async () => {
            if (pending.length === 0) return;
            const batch = pending;
            pending = [];
            await AssetDBService.setAssetFileSizes(batch)
                .catch(e => console.warn('[FreeUpSpaceScreen] Saving sizes failed:', e.message));
            if (!mounted.current) return;
            const sizeById = new Map(batch.map(({ id, size }) => [id, size]));
            const withSize = (item) => (sizeById.has(item.id) ? { ...item, sizeBytes: sizeById.get(item.id) } : item);
            setItemsByType(prev => ({ video: sortVideos(prev.video.map(withSize)), photo: prev.photo.map(withSize) }));
            loadSummary();
        };
        const worker = async () => {
            while (next < assets.length && mounted.current) {
                const asset = assets[next++];
                const size = await MediaService.getAssetSize(asset.id);
                if (size > 0) pending.push({ id: asset.id, size });
                if (pending.length >= SIZE_FLUSH_EVERY) await flush();
            }
        };
        await Promise.all(Array.from({ length: Math.min(SIZE_BACKFILL_CONCURRENCY, assets.length) }, worker));
        await flush();
    };

    const items = itemsByType[tab];
    const allItems = useMemo(() => [...itemsByType.video, ...itemsByType.photo], [itemsByType]);

    const toggleSelection = useCallback((id) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(id)) newSet.delete(id);
            else newSet.add(id);
            return newSet;
        });
    }, []);

    const allInTabSelected = items.length > 0 && items.every(item => selectedIds.has(item.id));
    const toggleSelectAll = () => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            items.forEach(item => (allInTabSelected ? newSet.delete(item.id) : newSet.add(item.id)));
            return newSet;
        });
    };

    const formatSize = (bytes) => formatBytesLog(bytes, { decimals: 1 });

    const totalSelectedSize = useMemo(() => {
        let total = 0;
        allItems.forEach(item => {
            if (selectedIds.has(item.id)) total += item.sizeBytes;
        });
        return total;
    }, [selectedIds, allItems]);

    const deleteVerified = async (idsToDelete) => {
        setIsDeleting(true);
        try {
            const { deleted, error } = await deleteInChunks(
                idsToDelete,
                (chunk) => MediaService.deleteLocalAssets(chunk),
                (chunk) => AssetDBService.markAssetsRemovedLocally(chunk),
                Platform.OS === 'android' ? ANDROID_DELETE_CHUNK : idsToDelete.length,
            );

            const gone = new Set(deleted);
            setItemsByType(prev => ({
                video: prev.video.filter(item => !gone.has(item.id)),
                photo: prev.photo.filter(item => !gone.has(item.id)),
            }));
            setSelectedIds(prev => new Set([...prev].filter(id => !gone.has(id))));
            loadSummary();

            if (!error) {
                Alert.alert("Success", "Successfully freed up space!");
            } else if (deleted.length > 0) {
                Alert.alert("Partly Done", `${deleted.length.toLocaleString('en-US')} removed from this phone. The rest were not deleted: ${error.message || 'cancelled'}`);
            } else {
                Alert.alert("Error", error.message || "Failed to delete files.");
            }
        } catch (e) {
            Alert.alert("Error", e.message || "Failed to delete files.");
        } finally {
            setIsDeleting(false);
        }
    };

    const handleDelete = async () => {
        if (selectedIds.size === 0) return;

        // Re-confirm with the server right now, not from cached flags, before
        // anything irreplaceable leaves the phone.
        setIsDeleting(true);
        let check;
        setVerifyProgress({ done: 0, total: selectedIds.size });
        try {
            check = await BackupSafetyService.checkAll(Array.from(selectedIds), (done, total) => {
                if (mounted.current) setVerifyProgress({ done, total });
            });
        } catch (e) {
            console.error('[FreeUpSpaceScreen] Safety check failed:', e);
            Alert.alert("Couldn't Verify Backup", "Nothing was deleted. Please make sure your Lomorage computer is on and try again.");
            return;
        } finally {
            setIsDeleting(false);
            setVerifyProgress(null);
        }
        const verifiedAt = Date.now();

        const { message, deletable } = buildDeleteConfirmation(check, allItems, formatSize);
        if (deletable.length === 0) {
            Alert.alert("Not Safe to Delete Yet", message);
            return;
        }

        Alert.alert(
            "Delete from Device",
            message,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete",
                    style: "destructive",
                    // The dialog may have sat open while things changed on the computer.
                    onPress: () => (isVerificationStale(verifiedAt) ? handleDelete() : deleteVerified(deletable)),
                }
            ]
        );
    };

    const playVideo = useCallback(async (item) => {
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
    }, []);

    const renderItem = ({ item }) => (
        <MediaCard
            item={item}
            isSelected={selectedIds.has(item.id)}
            playVideo={playVideo}
            toggleSelection={toggleSelection}
            formatSize={formatSize}
            serverEpoch={serverEpoch}
        />
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <ChevronLeft size={28} color="#007AFF" />
                    <Text style={styles.backText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.title}>Free Up Space</Text>
            </View>

            {summary && (
                <View style={styles.summary}>
                    <Text style={styles.summaryMain}>
                        {summary.backedUp > 0
                            ? `${describeCounts(summary.photos.backedUp, summary.videos.backedUp)} on this phone ${summary.backedUp === 1 ? 'is' : 'are'} backed up`
                            : 'Nothing on this phone is backed up yet'}
                    </Text>
                    {summary.backedUpBytes > 0 && (
                        <Text style={styles.summaryBytes}>
                            {summary.sizeIsPartial ? 'At least ' : ''}{formatSize(summary.backedUpBytes)} can be freed
                        </Text>
                    )}
                    {summary.notBackedUp > 0 && (
                        <Text style={styles.summaryNote}>
                            {summary.notBackedUp.toLocaleString('en-US')} not backed up yet — they stay on this phone.
                        </Text>
                    )}
                    {summary.skipped > 0 && (
                        <Text style={styles.summaryNote}>
                            {`${summary.skipped.toLocaleString('en-US')} in albums you don't back up — they stay on this phone.`}
                        </Text>
                    )}
                </View>
            )}

            <View style={styles.tabs}>
                {TABS.map(({ key, label }) => (
                    <TouchableOpacity
                        key={key}
                        style={[styles.tab, tab === key && styles.tabActive]}
                        onPress={() => setTab(key)}
                    >
                        <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                            {label} ({itemsByType[key].length.toLocaleString('en-US')})
                        </Text>
                    </TouchableOpacity>
                ))}
                <TouchableOpacity style={styles.selectAll} onPress={toggleSelectAll} disabled={items.length === 0}>
                    <Text style={[styles.selectAllText, items.length === 0 && styles.selectAllDisabled]}>
                        {allInTabSelected ? 'Deselect All' : 'Select All'}
                    </Text>
                </TouchableOpacity>
            </View>

            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="large" color="#007AFF" />
                    <Text style={styles.loadingText}>Finding backed-up photos and videos...</Text>
                </View>
            ) : items.length === 0 ? (
                <View style={styles.centered}>
                    <Text style={styles.emptyText}>
                        {tab === 'video' ? 'No backed-up videos on this phone.' : 'No backed-up photos on this phone.'}
                    </Text>
                </View>
            ) : (
                <View style={styles.listContainer}>
                    <FlashList
                        data={items}
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
                    {verifyProgress ? (
                        <Text style={styles.footerText}>
                            Checking with your Lomorage computer… {verifyProgress.done.toLocaleString('en-US')} of {verifyProgress.total.toLocaleString('en-US')}
                        </Text>
                    ) : (
                        <>
                            <Text style={styles.footerText}>Selected: {selectedIds.size.toLocaleString('en-US')}</Text>
                            <Text style={styles.footerSize}>{formatSize(totalSelectedSize)}</Text>
                        </>
                    )}
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

// Videos play on tap; photos toggle selection on tap. The circle always toggles selection.
const MediaCard = React.memo(function MediaCard({ item, isSelected, playVideo, toggleSelection, formatSize, serverEpoch }) {
    const [useRemoteFallback, setUseRemoteFallback] = React.useState(false);
    const { retryTick, onError: onRemoteRetryError } = useImageRetry(item.id);

    const remoteFallbackUri = item.hash
        ? MediaService.getPreviewUrl(item.hash, item.mediaType)
        : null;

    const displayUri = (useRemoteFallback && remoteFallbackUri)
        ? withRetryBuster(remoteFallbackUri, serverEpoch, retryTick)
        : item.uri;

    return (
        <TouchableOpacity
            style={styles.card}
            activeOpacity={0.8}
            onPress={() => (item.mediaType === 'video' ? playVideo(item) : toggleSelection(item.id))}
        >
            <Image
                source={{ uri: displayUri }}
                style={styles.thumbnail}
                contentFit="cover"
                recyclingKey={item.id}
                onError={(e) => {
                    if (remoteFallbackUri && !useRemoteFallback) {
                        setUseRemoteFallback(true);
                        return;
                    }
                    if (useRemoteFallback) onRemoteRetryError(e);
                }}
            />
            {item.sizeBytes > 0 && (
                <View style={styles.overlay}>
                    <View style={styles.sizeBadge}>
                        <Text style={styles.sizeText}>{formatSize(item.sizeBytes)}</Text>
                    </View>
                </View>
            )}
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
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 15,
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
    summary: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: '#f2f8ff',
    },
    summaryMain: {
        fontSize: 15,
        fontWeight: '600',
        color: '#1a1a1a',
    },
    summaryBytes: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#007AFF',
        marginTop: 2,
    },
    summaryNote: {
        fontSize: 13,
        color: '#666',
        marginTop: 4,
    },
    tabs: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    tab: {
        paddingVertical: 10,
        paddingHorizontal: 8,
        marginRight: 8,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabActive: {
        borderBottomColor: '#007AFF',
    },
    tabText: {
        fontSize: 15,
        color: '#666',
    },
    tabTextActive: {
        color: '#007AFF',
        fontWeight: '600',
    },
    selectAll: {
        marginLeft: 'auto',
        paddingVertical: 10,
    },
    selectAllText: {
        color: '#007AFF',
        fontSize: 15,
    },
    selectAllDisabled: {
        color: '#bbb',
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
