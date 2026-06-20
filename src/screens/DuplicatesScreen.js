import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
    StyleSheet, 
    View, 
    Text, 
    TouchableOpacity, 
    ActivityIndicator, 
    FlatList, 
    Dimensions, 
    Alert, 
    Platform, 
    Modal,
    ScrollView
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import { Eye, ChevronLeft, Trash2, Check, Copy, PlayCircle, X } from 'lucide-react-native';
import { AssetVideoPlayer } from './AssetDetailScreen';
import axios from 'axios';

import AIService from '../services/AIService';
import AssetDBService from '../services/AssetDBService';
import MediaService from '../services/MediaService';
import AuthService from '../services/AuthService';
import * as FileSystem from 'expo-file-system/legacy';
import * as Device from 'expo-device';
import { useSettings } from '../context/SettingsContext';

const { width } = Dimensions.get('window');

// Lazily resolves the local URI + size/dimensions for a local asset on first render.
// onMetadata(uri, width, height, size) is called once info is available.
function LazyLocalAsset({ assetId, style, onMetadata, ...rest }) {
    const [uri, setUri] = React.useState(null);
    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const info = await MediaService.getAssetInfo(assetId);
                if (cancelled || !info) return;
                let resolvedUri = info.localUri || info.uri;
                setUri(resolvedUri);
                if (onMetadata) {
                    let fileSize = 0;
                    try {
                        const fileInfo = await FileSystem.getInfoAsync(resolvedUri, { size: true });
                        fileSize = fileInfo?.size || 0;
                    } catch (_) {}
                    onMetadata(resolvedUri, info.width || 0, info.height || 0, fileSize);
                }
            } catch (_) {}
        })();
        return () => { cancelled = true; };
    }, [assetId]);
    return <Image source={{ uri }} style={style} {...rest} />;
}

// Standalone card for one asset within a duplicate group.
// Needed so that useState (for lazy metadata) follows React Hooks rules (no hooks in loops).
const AssetCard = React.memo(function AssetCard({ asset, idx, isSelected, onToggle, onSize, globalMeta, onOpenCompare }) {
    const isBest = idx === 0;
    const [localMeta, setLocalMeta] = React.useState({ width: 0, height: 0, size: 0 });

    const formatSizeLocal = (bytes) => {
        if (!bytes) return '';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <View style={styles.photoContainer}>
            <View style={{ position: 'relative' }}>
                <TouchableOpacity
                    activeOpacity={0.8}
                    style={styles.imageWrapper}
                    onPress={() => onOpenCompare()}
                >
                    {asset.isLocal && !asset.displayUri ? (
                        <LazyLocalAsset
                            assetId={asset.id}
                            style={styles.thumbnail}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            onMetadata={(uri, w, h, s) => {
                                setLocalMeta({ width: w, height: h, size: s });
                                if (onSize && s > 0) onSize(asset.id, s);
                            }}
                        />
                    ) : (
                        <Image
                            source={{ uri: asset.displayUri }}
                            style={styles.thumbnail}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                        />
                    )}

                    {/* Video Play Icon Overlay */}
                    {asset.mediaType === 'video' && (
                        <View style={styles.videoOverlay}>
                            <PlayCircle color="#fff" size={32} />
                        </View>
                    )}

                    {/* Keep / Duplicate Badge */}
                    <View style={[styles.badge, isBest ? styles.badgeKeep : styles.badgeDup]}>
                        <Text style={[styles.badgeText, isBest ? styles.badgeTextKeep : styles.badgeTextDup]}>
                            {isBest ? 'Keep' : 'Duplicate'}
                        </Text>
                    </View>
                </TouchableOpacity>

                {/* Selection Checkbox Overlay */}
                <TouchableOpacity 
                    style={[styles.checkbox, isSelected && styles.checkboxSelected]}
                    onPress={() => onToggle(asset.id)}
                    hitSlop={{ top: 25, bottom: 25, left: 25, right: 25 }}
                >
                    {isSelected && <Check color="#fff" size={14} strokeWidth={3} />}
                </TouchableOpacity>
            </View>

            {/* Photo info */}
            <View style={styles.photoInfo}>
                <Text style={styles.resolutionText}>
                    {(globalMeta?.width && globalMeta?.height) 
                        ? `${globalMeta.width}x${globalMeta.height}` 
                        : (localMeta.width && localMeta.height ? `${localMeta.width}x${localMeta.height}` : (asset.isLocal ? '...' : ''))}
                </Text>
                <Text style={styles.sizeText}>
                    {globalMeta?.size 
                        ? formatSizeLocal(globalMeta.size) 
                        : (localMeta.size ? formatSizeLocal(localMeta.size) : '')}
                </Text>
                <Text style={styles.storageType}>
                    {asset.isLocal ? 'Local' : 'Cloud'}
                </Text>
            </View>
        </View>
    );
}, (prevProps, nextProps) => {
    return prevProps.isSelected === nextProps.isSelected &&
           prevProps.globalMeta === nextProps.globalMeta &&
           prevProps.asset.id === nextProps.asset.id;
});

// Memoized group container to prevent massive FlatList re-renders when selection changes
const DuplicateGroup = React.memo(function DuplicateGroup({ group, groupIndex, selectedMap, modalMeta, toggleSelect, handleSize, handleIgnoreGroup, onOpenCompare }) {
    const formatDate = (timestamp) => {
        if (!timestamp) return 'Unknown Date';
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };

    return (
        <View style={styles.card}>
            <View style={styles.cardHeader}>
                <View>
                    <Text style={styles.cardTitle}>Group {groupIndex + 1} ({group.length} photos)</Text>
                    <Text style={styles.cardSubtitle}>
                        {formatDate(group[0]?.createTime)}
                    </Text>
                </View>
                <View style={styles.cardHeaderActions}>
                    <TouchableOpacity
                        style={styles.ignoreButton}
                        onPress={() => handleIgnoreGroup(group)}
                    >
                        <Text style={styles.ignoreText}>Ignore</Text>
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scrollContainer}
            >
                {group.map((asset, idx) => (
                    <AssetCard
                        key={asset.id}
                        asset={asset}
                        idx={idx}
                        isSelected={!!selectedMap[asset.id]}
                        onToggle={toggleSelect}
                        onSize={handleSize}
                        globalMeta={modalMeta[asset.id]}
                        onOpenCompare={() => onOpenCompare(group, idx)}
                    />
                ))}
            </ScrollView>
        </View>
    );
}, (prev, next) => {
    const selectionChanged = prev.group.some(asset => !!prev.selectedMap[asset.id] !== !!next.selectedMap[asset.id]);
    const metaChanged = prev.group.some(asset => prev.modalMeta[asset.id] !== next.modalMeta[asset.id]);
    return !selectionChanged && !metaChanged && prev.group === next.group;
});

// Standalone page for one asset within the comparison swiper.
// Encapsulates the loading/downloading state and metadata parsing for high-res/original photos.
function CompareItemPage({ item, index, isSelected, onToggle, setModalMeta, isFocused }) {
    const isBest = index === 0;
    const [loading, setLoading] = useState(false);
    const [downloadedUri, setDownloadedUri] = useState(null);
    const [meta, setMeta] = useState({ width: 0, height: 0, size: 0 });
    const [useOriginalVideo, setUseOriginalVideo] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (item.isLocal) {
                setLoading(true);
                try {
                    const info = await MediaService.getAssetInfo(item.id);
                    if (cancelled) return;
                    let resolvedUri = info.localUri || info.uri;
                    setDownloadedUri(resolvedUri);
                    let fileSize = 0;
                    try {
                        const fileInfo = await FileSystem.getInfoAsync(resolvedUri, { size: true });
                        fileSize = fileInfo?.size || 0;
                    } catch (_) {}
                    if (!cancelled) {
                        setMeta({
                            width: info.width || 0,
                            height: info.height || 0,
                            size: fileSize
                        });
                        setModalMeta(prev => ({
                            ...prev,
                            [item.id]: { width: info.width || 0, height: info.height || 0, size: fileSize }
                        }));
                    }
                } catch (e) {
                    console.error('[CompareItemPage] Local metadata error:', e);
                } finally {
                    if (!cancelled) setLoading(false);
                }
            } else {
                setLoading(true);
                try {
                    const serverUrl = AuthService.getServerUrl();
                    const token = AuthService.getToken();
                    const remoteUrl = `${serverUrl}/asset/${item.hash}?token=${token}`;
                    
                    if (item.mediaType === 'video') {
                        let videoUri = remoteUrl + '&ext=mp4';
                        if (useOriginalVideo) {
                            videoUri += '&orig=1';
                        }
                        
                        let fileSize = 0;
                        try {
                            const headRes = await axios.head(videoUri);
                            fileSize = parseInt(headRes.headers['content-length'] || 0, 10);
                        } catch (e) {
                            console.warn('[CompareItemPage] HEAD request failed for video size');
                        }

                        if (Platform.OS !== 'web' && Device.isDevice) {
                            try {
                                const convertToProxyURL = require('react-native-video-cache').default;
                                videoUri = convertToProxyURL(videoUri);
                            } catch (e) {
                                console.warn('[CompareItemPage] Failed to resolve proxy synchronously:', e);
                            }
                        }
                        
                        if (cancelled) return;
                        setDownloadedUri(videoUri);
                        setMeta({ width: 0, height: 0, size: fileSize });
                        setModalMeta(prev => ({
                            ...prev,
                            [item.id]: { width: 0, height: 0, size: fileSize }
                        }));
                        setLoading(false);
                    } else {
                        const localPath = `${FileSystem.cacheDirectory}${item.hash}`;
                        const fileInfo = await FileSystem.getInfoAsync(localPath, { size: true });
                        let targetUri = localPath;
                        let fileSize = 0;
                        
                        if (fileInfo.exists) {
                            fileSize = fileInfo.size || 0;
                        } else {
                            const downloadResult = await FileSystem.downloadAsync(remoteUrl, localPath);
                            targetUri = downloadResult.uri;
                            try {
                                const newInfo = await FileSystem.getInfoAsync(targetUri, { size: true });
                                fileSize = newInfo?.size || 0;
                            } catch (_) {
                                fileSize = 0;
                            }
                        }
                        
                        if (cancelled) return;
                        setDownloadedUri(targetUri);
                        
                        const { Image: RNImage } = require('react-native');
                        RNImage.getSize(targetUri, (w, h) => {
                            if (cancelled) return;
                            setMeta({ width: w, height: h, size: fileSize });
                            setModalMeta(prev => ({
                                ...prev,
                                [item.id]: { width: w, height: h, size: fileSize }
                            }));
                            setLoading(false);
                        }, (err) => {
                            console.warn('[CompareItemPage] Failed to get image size:', err);
                            if (cancelled) return;
                            setMeta({ width: 0, height: 0, size: fileSize });
                            setModalMeta(prev => ({
                                ...prev,
                                [item.id]: { width: 0, height: 0, size: fileSize }
                            }));
                            setLoading(false);
                        });
                    }
                } catch (e) {
                    console.error('[CompareItemPage] Remote download error:', e);
                    if (!cancelled) setLoading(false);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [item.id, item.hash, item.isLocal, item.mediaType, useOriginalVideo]);

    const formatSizeLocal = (bytes) => {
        if (!bytes) return 'Unknown';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <View style={[styles.modalItemPage, { width }]}>
            <View style={styles.modalImageWrapper}>
                {loading ? (
                    <ActivityIndicator size="large" color="#fff" />
                ) : downloadedUri ? (
                    item.mediaType === 'video' ? (
                        <AssetVideoPlayer
                            uri={downloadedUri}
                            style={styles.modalImage}
                            shouldPlay={isFocused}
                            nativeControls={true}
                        />
                    ) : (
                        <Image
                            source={{ uri: downloadedUri }}
                            style={styles.modalImage}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                        />
                    )
                ) : (
                    <Image
                        source={{ uri: item.displayUri }}
                        style={styles.modalImage}
                        contentFit="contain"
                        cachePolicy="memory-disk"
                    />
                )}
                
                {/* HD/SD Toggle for remote videos */}
                {!item.isLocal && item.mediaType === 'video' && (
                    <TouchableOpacity 
                        style={[
                            styles.qualityToggle, 
                            useOriginalVideo ? styles.qualityToggleActive : styles.qualityToggleInactive,
                            { position: 'absolute', top: 20, right: 20 }
                        ]}
                        onPress={() => setUseOriginalVideo(!useOriginalVideo)}
                    >
                        <Text style={useOriginalVideo ? styles.qualityTextActive : styles.qualityTextInactive}>
                            {useOriginalVideo ? 'HD' : 'SD'}
                        </Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* Details of current swiped item */}
            <View style={styles.modalMetaCard}>
                <View style={styles.modalMetaRow}>
                    <View style={[styles.badge, isBest ? styles.badgeKeep : styles.badgeDup, { position: 'relative', top: 0, left: 0, alignSelf: 'flex-start', marginBottom: 12 }]}>
                        <Text style={[styles.badgeText, isBest ? styles.badgeTextKeep : styles.badgeTextDup]}>
                            {isBest ? 'Recommend Keep' : 'Duplicate'}
                        </Text>
                    </View>
                    <Text style={styles.modalFilename} numberOfLines={1}>{item.filename || 'Photo Details'}</Text>
                </View>

                <View style={styles.modalSpecsRow}>
                    <View style={styles.specColumn}>
                        <Text style={styles.specLabel}>Resolution</Text>
                        <Text style={styles.specValue}>
                            {meta.width && meta.height ? `${meta.width}x${meta.height}` : '...'}
                        </Text>
                    </View>
                    <View style={styles.specColumn}>
                        <Text style={styles.specLabel}>File Size</Text>
                        <Text style={styles.specValue}>
                            {meta.size ? formatSizeLocal(meta.size) : '...'}
                        </Text>
                    </View>
                    <View style={styles.specColumn}>
                        <Text style={styles.specLabel}>Location</Text>
                        <Text style={styles.specValue}>{item.isLocal ? 'Local' : 'Cloud Only'}</Text>
                    </View>
                </View>

                {/* Select button for current swiped item */}
                <TouchableOpacity 
                    style={[
                        styles.modalSelectBtn, 
                        isSelected ? styles.modalSelectBtnRemove : styles.modalSelectBtnKeep
                    ]}
                    onPress={() => onToggle(item.id)}
                >
                    <Text style={styles.modalSelectBtnText}>
                        {isSelected ? 'Keep this photo (Deselect)' : 'Delete this photo (Select)'}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

export default function DuplicatesScreen() {
    const insets = useSafeAreaInsets();
    const navigation = useNavigation();
    const { debugMode } = useSettings();
    const [loading, setLoading] = useState(true);
    const [deleting, setDeleting] = useState(false);
    const [groups, setGroups] = useState([]);
    const [selectedMap, setSelectedMap] = useState({}); // id -> boolean
    const [sizesMap, setSizesMap] = useState({});
    
    // Compare modal state
    const [compareGroup, setCompareGroup] = useState(null);
    const [compareIndex, setCompareIndex] = useState(0);
    const [modalMeta, setModalMeta] = useState({});

    const groupsRef = useRef([]);

    // Keep groupsRef in sync with groups state
    useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);

    const loadDuplicates = async (forceRescan = false) => {
        // Prevent loading spinner flash if we already have groups in memory and not forcing rescan
        if (groupsRef.current.length === 0 || forceRescan) {
            setLoading(true);
        }
        try {
            console.log(`[DuplicatesScreen] Running duplicate detection algorithm (force=${forceRescan})...`);
            const result = await AIService.findDuplicateGroups(forceRescan);
            setGroups(result);
            
            // Initialize selection map ONLY if forcing a rescan or if we didn't have groups before.
            // This prevents the user's selection from resetting when they switch tabs and come back.
            if (forceRescan || groupsRef.current.length === 0) {
                const initialMap = {};
                result.forEach(group => {
                    group.slice(1).forEach(asset => {
                        initialMap[asset.id] = true;
                    });
                });
                setSelectedMap(initialMap);
            }
        } catch (error) {
            console.error('[DuplicatesScreen] Failed to load duplicates:', error);
            Alert.alert(
                'Oops', 
                debugMode 
                    ? `Failed to load duplicates: ${error.message}` 
                    : 'We ran into a hiccup while finding duplicates. Please try again.'
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const unsubscribe = navigation.addListener('focus', () => {
            loadDuplicates();
        });
        return unsubscribe;
    }, [navigation]);

    // Toggle photo selection
    const toggleSelect = useCallback((id) => {
        setSelectedMap(prev => ({
            ...prev,
            [id]: !prev[id]
        }));
    }, []);

    const handleSize = useCallback((id, size) => {
        setSizesMap(prev => prev[id] === size ? prev : { ...prev, [id]: size });
    }, []);

    // Ignore an entire group of duplicates
    const handleIgnoreGroup = useCallback((group) => {
        if (!group || group.length === 0) return;
        
        // Capture IDs as primitives BEFORE the Alert opens, to avoid stale closure issues
        const assetIds = group.map(a => a.id);
        const firstId = group[0]?.id;

        Alert.alert(
            'Ignore Group',
            'This group will not appear in the cleanup list again.',
            [
                { text: 'Cancel', style: 'cancel' },
                { 
                    text: 'Ignore', 
                    style: 'destructive',
                    onPress: () => {
                        // Optimistically remove from UI immediately
                        setGroups(prev => prev.filter(g => g[0]?.id !== firstId));
                        setSelectedMap(prev => {
                            const copy = { ...prev };
                            assetIds.forEach(id => delete copy[id]);
                            return copy;
                        });
                        
                        // Persist to DB in background
                        AssetDBService.ignoreAssetsForDuplicates(assetIds).catch(e => {
                            console.error('[DuplicatesScreen] Failed to ignore group in DB:', e);
                        });
                        AIService.removeDuplicateGroupFromCache(assetIds); // Update memory cache without clearing it
                    }
                }
            ]
        );
    }, []);

    let selectedCount = 0;
    let selectedSize = 0; // bytes

    groups.forEach(group => {
        group.forEach(asset => {
            if (selectedMap[asset.id]) {
                selectedCount++;
                selectedSize += sizesMap[asset.id] || (modalMeta[asset.id] && modalMeta[asset.id].size) || asset.size || 0;
            }
        });
    });

    const formatSize = (bytes) => {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Perform bulk deletion of selected duplicates
    const handleDeleteSelected = async () => {
        if (selectedCount === 0) return;

        Alert.alert(
            'Confirm Deletion',
            `Are you sure you want to delete the selected ${selectedCount} photos? This will free up ${formatSize(selectedSize)}.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Confirm Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setDeleting(true);
                        try {
                            const localIdsToDelete = [];
                            const remoteItemsToDelete = [];
                            const allIdsOrHashes = [];

                            groups.forEach(group => {
                                group.forEach(asset => {
                                    if (selectedMap[asset.id]) {
                                        allIdsOrHashes.push(asset.id);
                                        if (asset.hash) allIdsOrHashes.push(asset.hash);

                                        if (asset.isLocal) {
                                            localIdsToDelete.push(asset.id);
                                        } else {
                                            remoteItemsToDelete.push({
                                                idOrHash: asset.hash,
                                                isHash: true
                                            });
                                        }
                                    }
                                });
                            });

                            // 1. Delete local assets first (will prompt OS confirmation dialog)
                            if (localIdsToDelete.length > 0) {
                                try {
                                    await MediaService.deleteLocalAssets(localIdsToDelete);
                                } catch (le) {
                                    console.log('[DuplicatesScreen] Local deletion cancelled or failed:', le.message);
                                    Alert.alert(
                                        'Action Cancelled', 
                                        'No photos were deleted because system permission was not granted.'
                                    );
                                    setDeleting(false);
                                    return;
                                }
                            }

                            // 2. Delete remote assets in bulk from server
                            if (remoteItemsToDelete.length > 0) {
                                try {
                                    await MediaService.deleteRemoteAssets(remoteItemsToDelete);
                                } catch (re) {
                                    console.warn('[DuplicatesScreen] Remote deletion failed:', re.message);
                                }
                            }

                            // 3. Remove from local SQLite database in a single transaction
                            await AssetDBService.deleteAssets(allIdsOrHashes);

                            // 4. Reload duplicates list to reflect changes
                            AIService.clearDuplicateCache();
                            Alert.alert('Success', `Selected photos cleaned up successfully!`);
                            loadDuplicates();
                        } catch (err) {
                            console.error('[DuplicatesScreen] Deletion error:', err);
                            Alert.alert(
                                'Cleanup Incomplete', 
                                debugMode 
                                    ? `Error cleaning photos: ${err.message}` 
                                    : 'We couldn\'t finish cleaning up all selected photos. Please check your connection and try again.'
                            );
                        } finally {
                            setDeleting(false);
                        }
                    }
                }
            ]
        );
    };

    const handleOpenCompare = useCallback((group, idx) => {
        setCompareGroup(group);
        setCompareIndex(idx);
    }, []);

    const renderGroupItem = useCallback(({ item: group, index: groupIndex }) => {
        return (
            <DuplicateGroup 
                group={group}
                groupIndex={groupIndex}
                selectedMap={selectedMap}
                modalMeta={modalMeta}
                toggleSelect={toggleSelect}
                handleSize={handleSize}
                handleIgnoreGroup={handleIgnoreGroup}
                onOpenCompare={handleOpenCompare}
            />
        );
    }, [selectedMap, modalMeta, toggleSelect, handleSize, handleIgnoreGroup, handleOpenCompare]);

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={[styles.header, { height: 56 }]}>
                <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
                    <ChevronLeft color="#007AFF" size={26} />
                </TouchableOpacity>
                <View style={styles.headerTitleContainer}>
                    <Text style={styles.title}>Duplicates Cleanup</Text>
                    {!loading && groups.length > 0 && (
                        <Text style={styles.subtitle}>Found {groups.length} groups of duplicates</Text>
                    )}
                </View>
                <View style={{ width: 40 }} />
            </View>

            {/* Content Body */}
            {loading ? (
                <View style={styles.centerContainer}>
                    <ActivityIndicator size="large" color="#007AFF" />
                    <Text style={styles.loadingText}>Scanning library for duplicates...</Text>
                    <Text style={styles.loadingSubtext}>
                        {debugMode 
                            ? 'This may take a few seconds, clustering photos by perceptual hash...' 
                            : 'This may take a few moments while we find similar photos for you...'}
                    </Text>
                </View>
            ) : groups.length === 0 ? (
                <View style={styles.centerContainer}>
                    <View style={styles.emptyIconContainer}>
                        <Copy color="#A2A2A2" size={60} strokeWidth={1.2} />
                    </View>
                    <Text style={styles.emptyText}>Your library is clean!</Text>
                    <Text style={styles.emptySubtext}>No duplicates or highly similar photos found.</Text>
                    <TouchableOpacity style={styles.reloadBtn} onPress={() => loadDuplicates(true)}>
                        <Text style={styles.reloadBtnText}>Rescan</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <FlatList
                    data={groups}
                    renderItem={renderGroupItem}
                    keyExtractor={(item) => `group-${item[0]?.id || item[0]?.hash || Math.random()}`}
                    contentContainerStyle={styles.listContent}
                />
            )}

            {/* Sticky Action Footer */}
            {!loading && groups.length > 0 && (
                <View style={styles.footer}>
                    <View style={styles.footerLeft}>
                        <Text style={styles.footerCount}>Selected {selectedCount} photos</Text>
                        <Text style={styles.footerSavings}>Save {formatSize(selectedSize)}</Text>
                    </View>
                    <TouchableOpacity 
                        disabled={selectedCount === 0 || deleting}
                        style={[styles.deleteBtn, selectedCount === 0 && styles.deleteBtnDisabled]}
                        onPress={handleDeleteSelected}
                    >
                        {deleting ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <>
                                <Trash2 color="#fff" size={18} />
                                <Text style={styles.deleteBtnText}>Clean Selected</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>
            )}

            {/* Swipeable Horizontal Comparison Modal */}
            {compareGroup && (
                <Modal 
                    visible={true} 
                    transparent={true} 
                    animationType="slide"
                    onRequestClose={() => setCompareGroup(null)}
                >
                    <View style={[styles.modalBg, { paddingTop: Math.max(insets.top, 0) }]}>
                        <View style={styles.modalHeader}>
                            <View>
                                <Text style={styles.modalTitle}>Compare Duplicates</Text>
                                <Text style={styles.modalSubtitle}>
                                    Photo {compareIndex + 1} of {compareGroup.length} (Swipe left/right to compare)
                                </Text>
                            </View>
                            <TouchableOpacity 
                                style={styles.modalCloseBtn}
                                onPress={() => setCompareGroup(null)}
                            >
                                <X color="#fff" size={24} />
                            </TouchableOpacity>
                        </View>

                        <View style={styles.modalSwiperContainer}>
                            <FlatList
                                horizontal
                                pagingEnabled
                                data={compareGroup}
                                showsHorizontalScrollIndicator={false}
                                keyExtractor={(item) => item.id}
                                initialScrollIndex={compareIndex}
                                getItemLayout={(data, index) => ({
                                    length: width,
                                    offset: width * index,
                                    index
                                })}
                                onMomentumScrollEnd={(e) => {
                                    const index = Math.round(e.nativeEvent.contentOffset.x / width);
                                    setCompareIndex(index);
                                }}
                                renderItem={({ item, index }) => (
                                    <CompareItemPage
                                        item={item}
                                        index={index}
                                        isSelected={!!selectedMap[item.id]}
                                        onToggle={toggleSelect}
                                        setModalMeta={setModalMeta}
                                        isFocused={index === compareIndex}
                                    />
                                )}
                            />
                        </View>
                    </View>
                </Modal>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F2F2F7',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#E5E5EA',
    },
    backBtn: {
        width: 40,
        height: 40,
        justifyContent: 'center',
    },
    headerTitleContainer: {
        alignItems: 'center',
    },
    title: {
        fontSize: 17,
        fontWeight: 'bold',
        color: '#1C1C1E',
    },
    subtitle: {
        fontSize: 12,
        color: '#8E8E93',
        marginTop: 2,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    loadingText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#1C1C1E',
        marginTop: 16,
        textAlign: 'center',
    },
    loadingSubtext: {
        fontSize: 13,
        color: '#8E8E93',
        marginTop: 8,
        textAlign: 'center',
    },
    emptyIconContainer: {
        width: 120,
        height: 120,
        borderRadius: 60,
        backgroundColor: '#F5F5F5',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 24,
    },
    qualityToggle: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderRadius: 16,
        borderWidth: 1,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 3,
    },
    qualityToggleActive: {
        backgroundColor: '#007AFF',
        borderColor: '#007AFF',
    },
    qualityToggleInactive: {
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderColor: 'rgba(255,255,255,0.3)',
    },
    qualityTextActive: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#fff',
    },
    qualityTextInactive: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#fff',
    },
    emptyText: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1C1C1E',
        marginBottom: 8,
        textAlign: 'center',
    },
    emptySubtext: {
        fontSize: 14,
        color: '#8E8E93',
        textAlign: 'center',
        marginBottom: 24,
    },
    reloadBtn: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: '#007AFF',
    },
    reloadBtnText: {
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 14,
    },
    listContent: {
        paddingVertical: 8,
        paddingBottom: 110, // Avoid overlapping with action footer
    },
    card: {
        backgroundColor: '#fff',
        borderRadius: 16,
        padding: 16,
        marginHorizontal: 16,
        marginVertical: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
        elevation: 2,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#F2F2F7',
        paddingBottom: 8,
    },
    cardTitle: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1C1C1E',
    },
    cardSubtitle: {
        fontSize: 12,
        color: '#8E8E93',
        marginTop: 2,
    },
    cardHeaderActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    compareButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#E5F2FF',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 12,
        marginRight: 8,
    },
    compareButtonText: {
        fontSize: 12,
        color: '#007AFF',
        fontWeight: '600',
        marginLeft: 4,
    },
    ignoreButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 12,
        backgroundColor: '#F2F2F7',
    },
    ignoreText: {
        fontSize: 12,
        color: '#8E8E93',
        fontWeight: '500',
    },
    scrollContainer: {
        paddingVertical: 4,
    },
    photoContainer: {
        width: 130,
        marginRight: 12,
    },
    imageWrapper: {
        width: 130,
        height: 130,
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        backgroundColor: '#F2F2F7',
    },
    thumbnail: {
        width: '100%',
        height: '100%',
    },
    badge: {
        position: 'absolute',
        top: 6,
        left: 6,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 6,
    },
    badgeKeep: {
        backgroundColor: '#34C759',
    },
    badgeDup: {
        backgroundColor: 'rgba(0,0,0,0.6)',
    },
    badgeText: {
        fontSize: 9,
        fontWeight: 'bold',
    },
    badgeTextKeep: {
        color: '#fff',
    },
    badgeTextDup: {
        color: '#FF9500',
    },
    checkbox: {
        position: 'absolute',
        bottom: 8,
        right: 8,
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: '#fff',
        backgroundColor: 'rgba(0,0,0,0.3)',
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
    },
    checkboxSelected: {
        backgroundColor: '#FF3B30',
        borderColor: '#FF3B30',
    },
    photoInfo: {
        marginTop: 8,
        alignItems: 'center',
    },
    resolutionText: {
        fontSize: 10,
        color: '#8E8E93',
        textAlign: 'center',
    },
    sizeText: {
        fontSize: 11,
        fontWeight: '600',
        color: '#1C1C1E',
        marginTop: 2,
        textAlign: 'center',
    },
    storageType: {
        fontSize: 9,
        color: '#AEAEB2',
        marginTop: 1,
        textAlign: 'center',
    },
    previewIconBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: '#F2F2F7',
    },
    previewText: {
        fontSize: 10,
        color: '#007AFF',
        marginLeft: 4,
        fontWeight: '500',
    },
    footer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 84,
        backgroundColor: '#fff',
        borderTopWidth: 1,
        borderTopColor: '#E5E5EA',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingBottom: Platform.OS === 'ios' ? 24 : 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.05,
        shadowRadius: 5,
        elevation: 10,
    },
    footerLeft: {
        justifyContent: 'center',
    },
    footerCount: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1C1C1E',
    },
    footerSavings: {
        fontSize: 12,
        color: '#FF3B30',
        marginTop: 2,
        fontWeight: '500',
    },
    deleteBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#FF3B30',
        paddingHorizontal: 20,
        height: 44,
        borderRadius: 22,
        shadowColor: '#FF3B30',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
    },
    deleteBtnDisabled: {
        backgroundColor: '#E5E5EA',
        shadowOpacity: 0,
        elevation: 0,
    },
    deleteBtnText: {
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 14,
        marginLeft: 6,
    },
    modalBg: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.96)',
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        height: 56,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(0,0,0,0.3)',
    },
    modalTitle: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    modalSubtitle: {
        color: '#8E8E93',
        fontSize: 11,
        marginTop: 2,
    },
    modalCloseBtn: {
        width: 44,
        height: 44,
        justifyContent: 'center',
        alignItems: 'flex-end',
    },
    modalSwiperContainer: {
        flex: 1,
    },
    modalItemPage: {
        flex: 1,
        justifyContent: 'space-between',
    },
    modalImageWrapper: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 10,
    },
    modalImage: {
        width: '100%',
        height: '100%',
    },
    modalMetaCard: {
        backgroundColor: 'rgba(28,28,30,0.95)',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
        padding: 20,
        paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    },
    modalMetaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.08)',
        paddingBottom: 10,
        marginBottom: 12,
    },
    modalFilename: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
        flex: 1,
        textAlign: 'right',
        marginLeft: 16,
    },
    modalSpecsRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    specColumn: {
        flex: 1,
    },
    specLabel: {
        color: '#8E8E93',
        fontSize: 10,
        textTransform: 'uppercase',
        marginBottom: 4,
    },
    specValue: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    modalSelectBtn: {
        height: 46,
        borderRadius: 23,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 5,
    },
    modalSelectBtnKeep: {
        backgroundColor: '#FF3B30',
    },
    modalSelectBtnRemove: {
        backgroundColor: '#34C759',
    },
    modalSelectBtnText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    videoOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.15)',
    },
});
