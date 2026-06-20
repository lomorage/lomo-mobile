import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StyleSheet, View, Dimensions, TouchableOpacity, Text, FlatList, Alert, DeviceEventEmitter, Pressable, ActivityIndicator, Animated, Vibration, ScrollView, PanResponder, Platform } from 'react-native';
import { Image } from 'expo-image';
import { ChevronLeft, CloudUpload, Trash2, Share, Heart, FolderMinus, Sparkles } from 'lucide-react-native';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import convertToProxyURL from 'react-native-video-cache';
import * as Device from 'expo-device';
import AuthService from '../services/AuthService';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import { useSettings } from '../context/SettingsContext';
import RemoteAlbumService from '../services/RemoteAlbumService';
import UploadService from '../services/UploadService';
import axios from 'axios';
import NetworkQueue from '../services/NetworkQueue';
import OfflineCacheService from '../services/OfflineCacheService';
import AssetDBService from '../services/AssetDBService';
import GalleryStore from '../store/GalleryStore';
import ZoomableMedia from '../components/ZoomableMedia';

const { width, height } = Dimensions.get('window');

const isLivePhoto = (asset) => {
    // 1. Local or synced asset with mediaSubtypes metadata
    if (asset.mediaSubtypes && (asset.mediaSubtypes.includes('livePhoto') || asset.mediaSubtypes.includes('live'))) {
        return true;
    }
    // 2. Synced local or remote asset check using cached hash in remoteTree
    if (asset.hash) {
        const remoteNode = SyncService.remoteTree?.getNodeByHash(asset.hash);
        if (remoteNode && remoteNode.tag && remoteNode.tag.toLowerCase().endsWith('.zip')) {
            return true;
        }
    }
    return false;
};

const getCacheKey = (item) => {
    if (item.status === 'remote') {
        return item.hash;
    }
    // For local and synced assets, sanitize item.id (which is the localIdentifier)
    return item.id ? item.id.replace(/[^a-zA-Z0-9]/g, '') : '';
};

const LivePhotoIcon = ({ color = '#fff', size = 14 }) => {
    const innerSize = size * 0.45;
    const middleSize = size * 0.75;
    return (
        <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
            {/* Outer dashed concentric ring */}
            <View style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 1,
                borderColor: color,
                borderStyle: 'dashed',
                opacity: 0.8
            }} />
            {/* Middle solid ring */}
            <View style={{
                position: 'absolute',
                width: middleSize,
                height: middleSize,
                borderRadius: middleSize / 2,
                borderWidth: 1,
                borderColor: color,
                opacity: 0.9
            }} />
            {/* Center solid dot */}
            <View style={{
                width: innerSize,
                height: innerSize,
                borderRadius: innerSize / 2,
                backgroundColor: color
            }} />
        </View>
    );
};

export function AssetVideoPlayer({ uri, style, shouldPlay, nativeControls = false }) {
    const [isLoading, setIsLoading] = React.useState(false);
    const loadingTimerRef = React.useRef(null);

    console.log(`[AssetVideoPlayer] Rendered with uri=${uri}, shouldPlay=${shouldPlay}`);

    const player = useVideoPlayer(uri, player => {
        player.loop = !nativeControls;
        console.log(`[AssetVideoPlayer] Player initialized, loop=${player.loop}`);
        if (shouldPlay) {
            console.log(`[AssetVideoPlayer] Starting playback synchronously in player initializer`);
            player.play();
        }
    });

    React.useEffect(() => {
        console.log(`[AssetVideoPlayer] useEffect mount, player.status=${player.status}, uri=${uri}`);
        
        const showLoaderDelayed = () => {
            console.log(`[AssetVideoPlayer] Scheduling loader show...`);
            if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
            loadingTimerRef.current = setTimeout(() => {
                console.log(`[AssetVideoPlayer] Loader show timer fired, setting isLoading=true`);
                setIsLoading(true);
            }, 800); // Only show spinner if load takes >800ms (prevent flashing for cached/local videos)
        };

        const hideLoader = () => {
            console.log(`[AssetVideoPlayer] Hiding loader...`);
            if (loadingTimerRef.current) {
                clearTimeout(loadingTimerRef.current);
                loadingTimerRef.current = null;
            }
            setIsLoading(false);
        };

        if (player.status === 'loading') {
            showLoaderDelayed();
        } else {
            hideLoader();
        }
        
        const sub = player.addListener('statusChange', ({ status }) => {
            console.log(`[AssetVideoPlayer] statusChange event received: status=${status}`);
            if (status === 'loading') {
                showLoaderDelayed();
            } else if (status === 'readyToPlay') {
                hideLoader();
                if (shouldPlay) {
                    console.log(`[AssetVideoPlayer] statusChange readyToPlay -> calling player.play()`);
                    try { player.play(); } catch(e) { console.error('[AssetVideoPlayer] play error:', e); }
                }
            } else {
                hideLoader();
            }
        });

        const timeSub = player.addListener('timeUpdate', ({ currentTime }) => {
            // Once playback progress is updating, the video is definitely rendering frames
            hideLoader();
        });
        
        if (shouldPlay) {
            console.log(`[AssetVideoPlayer] shouldPlay is true -> calling player.play()`);
            try { player.play(); } catch(e) { console.error('[AssetVideoPlayer] play error in mount:', e); }
            // Backup timeout in case statusChange doesn't fire
            setTimeout(() => {
                if (shouldPlay) {
                    console.log(`[AssetVideoPlayer] backup timeout -> calling player.play()`);
                    try { player.play(); } catch(e) {}
                }
            }, 100);
        } else {
            console.log(`[AssetVideoPlayer] shouldPlay is false -> calling player.pause()`);
            player.pause();
        }
        
        return () => {
            console.log(`[AssetVideoPlayer] useEffect unmount for player, cleaning listeners`);
            sub.remove();
            timeSub.remove();
            if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
        };
    }, [shouldPlay, player]);

    return (
        <View style={[style, { backgroundColor: 'transparent' }]}>
            <VideoView 
                style={StyleSheet.absoluteFillObject} 
                player={player}
                allowsPictureInPicture 
                nativeControls={nativeControls}
            />
            
            {isLoading && (
                <View style={[StyleSheet.absoluteFillObject, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'transparent' }]}>
                    <ActivityIndicator size="large" color="#007AFF" />
                </View>
            )}
        </View>
    );
}

export default function AssetDetailScreen({ route, navigation }) {
    const flatListRef = useRef(null);
    const { initialIndex, source = 'gallery' } = route.params;
    const [assets, setAssets] = useState(GalleryStore.getAssets(source));
    
    const { debugMode } = useSettings();
    const [useOriginalVideo, setUseOriginalVideo] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
    const [extractedVideoUris, setExtractedVideoUris] = useState({});
    const [isPreparingLive, setIsPreparingLive] = useState(false);
    const [isLivePlaying, setIsLivePlaying] = useState(false);
    const [flatListScrollEnabled, setFlatListScrollEnabled] = useState(true);
    const [isSharing, setIsSharing] = useState(false);
    const [isFavorite, setIsFavorite] = useState(false);
    const [userAlbums, setUserAlbums] = useState([]);
    const [toastMessage, setToastMessage] = useState(null);
    const [undoAction, setUndoAction] = useState(null);
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const fadeAnim = useRef(new Animated.Value(0)).current;

    const flatListScrollEnabledRef = useRef(flatListScrollEnabled);
    useEffect(() => {
        flatListScrollEnabledRef.current = flatListScrollEnabled;
    }, [flatListScrollEnabled]);

    const swipeActionRef = useRef();
    
    const panResponder = useRef(
        PanResponder.create({
            onMoveShouldSetPanResponderCapture: (evt, gestureState) => {
                // Trigger if swipe is upward, mostly vertical, and image is not zoomed
                const isVertical = Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.5;
                const isUpward = gestureState.dy < -15 || gestureState.vy < -0.3;
                return isVertical && isUpward && flatListScrollEnabledRef.current;
            },
            onPanResponderRelease: (evt, gestureState) => {
                // Confirm if swiped up sufficiently far or with a fast flick
                if (gestureState.dy < -50 || gestureState.vy < -0.5) {
                    if (swipeActionRef.current) swipeActionRef.current();
                }
            }
        })
    ).current;

    useEffect(() => {
        const fetchAlbums = async () => {
            try {
                // Fetch flat list of albums for Slidebox
                const rootCollection = await RemoteAlbumService.getAlbumsHierarchy({ priority: 1, groupId: 'Albums' });
                const items = rootCollection.getItems();
                // Filter out folders and system albums
                const albums = items.filter(i => i.type === 'album' && !i.data.name.startsWith('/'));
                setUserAlbums(albums);
            } catch (e) {
                console.error('[AssetDetailScreen] Error fetching slidebox albums:', e);
            }
        };
        fetchAlbums();
    }, []);

    useEffect(() => {
        if (toastMessage) {
            const timer = setTimeout(() => {
                setToastMessage(null);
                setUndoAction(null);
            }, 3000);
            return () => clearTimeout(timer);
        }
    }, [toastMessage]);

    useEffect(() => {
        const item = assets[currentIndex];
        if (!item) return;
        if (item.status === 'remote') {
            setIsFavorite(item.isFavorite === true);
        } else {
            setIsFavorite(false);
        }

        // On-demand metadata fetching for Album assets that haven't synced yet
        if (item.isMetadataPartial && item.status === 'remote' && item.hash) {
            const fetchMeta = async () => {
                try {
                    const url = AuthService.getServerUrl();
                    const res = await axios.get(`${url}/asset/metadata/${item.hash}`, {
                        headers: { Authorization: `token=${AuthService.getToken()}` },
                        timeout: 5000,
                        skipAutoProbe: true,
                        priority: 1,
                        groupId: 'AssetDetail'
                    });
                    if (res.status === 200 && res.data) {
                        const metadata = res.data;
                        const newAssets = [...assets];
                        newAssets[currentIndex] = {
                            ...item,
                            isMetadataPartial: false,
                            mediaType: metadata.type === 1 ? 'video' : 'image',
                            creationTime: metadata.date ? new Date(metadata.date).getTime() : item.creationTime,
                            filename: metadata.name,
                            mediaSubtypes: metadata.subtype ? [metadata.subtype] : []
                        };
                        GalleryStore.setAssets(newAssets, source);
                        setAssets(newAssets);
                    }
                } catch(e) {
                    console.warn('[AssetDetail] Failed to fetch on-demand metadata', e.message);
                }
            };
            fetchMeta();
        }

        return () => {
            NetworkQueue.cancelGroup('AssetDetail');
        };
    }, [currentIndex, assets.length]);

    const handleToggleFavorite = async () => {
        const item = assets[currentIndex];
        if (!item || (item.status !== 'remote' && item.status !== 'synced') || !item.hash) return;
        
        const newValue = !isFavorite;
        setIsFavorite(newValue); // Optimistic UI update
        item.isFavorite = newValue; // Update local array to keep it in sync
        GalleryStore.setAssets([...assets], source); // Force re-render of thumbnails in grids

        try {
            await OfflineCacheService.toggleFavorite(item.hash, newValue);
            // Optionally, emit an event if other screens need to update immediately
        } catch (error) {
            console.error('[AssetDetailScreen] Failed to toggle favorite:', error);
            // Revert on failure
            setIsFavorite(!newValue);
            item.isFavorite = !newValue;
            GalleryStore.setAssets([...assets], source);
            Alert.alert('Error', 'Failed to update favorite status');
        }
    };

    useEffect(() => {
        let active = true;
        const prepareVideo = async () => {
            const item = assets[currentIndex];
            if (!item || !isLivePhoto(item)) return;
            
            const cacheKey = getCacheKey(item);
            if (extractedVideoUris[cacheKey]) return; // Already prepared in memory!
            
            setIsPreparingLive(true);
            try {
                let videoPath = null;
                const FileSystem = require('expo-file-system/legacy');
                const cacheVideoPath = `${FileSystem.cacheDirectory}${cacheKey}.mov`;
                
                // 1. First, check if we already have the extracted video file cached on the local disk!
                const fileInfo = await FileSystem.getInfoAsync(cacheVideoPath);
                if (fileInfo.exists) {
                    console.log(`[AssetDetail] Local disk cache hit for video: ${cacheVideoPath}`);
                    videoPath = cacheVideoPath;
                } else {
                    // Cache miss: extract it!
                    if (item.status === 'remote') {
                        const baseUrl = AuthService.getServerUrl();
                        const token = AuthService.getToken();
                        const remoteZipUrl = `${baseUrl}/asset/${cacheKey}?token=${token}`;
                        
                        const localZipPath = `${FileSystem.cacheDirectory}${cacheKey}.zip`;
                        console.log(`[AssetDetail] Downloading remote Live Photo Zip: ${remoteZipUrl} -> ${localZipPath}`);
                        
                        const downloadResult = await FileSystem.downloadAsync(remoteZipUrl, localZipPath);
                        
                        if (active && downloadResult.status === 200) {
                            console.log(`[AssetDetail] Native unzipping video from: ${downloadResult.uri}`);
                            // Native module extracts directly into cachesDir matching cacheVideoPath
                            videoPath = await MediaService.extractVideoFromZipAsync(downloadResult.uri);
                            
                            // Clean up downloaded zip to save disk space
                            try {
                                await FileSystem.deleteAsync(downloadResult.uri);
                            } catch(e) {}
                        }
                    } else {
                        // Local asset: fetch from Photos library
                        console.log(`[AssetDetail] Fetching local Live Photo video path: ${item.uri}`);
                        // Native module extracts directly into cachesDir matching cacheVideoPath
                        videoPath = await MediaService.getLocalLivePhotoVideoUriAsync(item.uri);
                    }
                }
                
                if (active && videoPath) {
                    console.log(`[AssetDetail] Prepared Live Photo video path: ${videoPath}`);
                    setExtractedVideoUris(prev => ({ ...prev, [cacheKey]: videoPath }));
                }
            } catch (e) {
                console.warn('[AssetDetail] Failed to prepare Live Photo video:', e.message);
            } finally {
                if (active) {
                    setIsPreparingLive(false);
                }
            }
        };
        
        prepareVideo();
        
        return () => {
            active = false;
            setIsLivePlaying(false); // Stop playing when index changes
            scaleAnim.setValue(1.0);
            fadeAnim.setValue(0);
        };
    }, [currentIndex, assets]);


    
    const currentAsset = assets[currentIndex] || {};

    const handleAddToAlbum = async (album) => {
        if (!currentAsset || !currentAsset.hash) return;
        
        // Optimistic toast with Undo
        setToastMessage(`Added to ${album.data.name}`);
        setUndoAction(() => async () => {
            await RemoteAlbumService.removeAssetFromAlbum(album.data.info.id, currentAsset.hash);
            setToastMessage(`Undid Add`);
            setUndoAction(null);
        });
        
        try {
            await RemoteAlbumService.addAssetToAlbum(album.data.info.id, currentAsset.hash);
            // Auto advance
            if (currentIndex < assets.length - 1) {
                flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
            }
        } catch (e) {
            setToastMessage(`Failed to add to ${album.data.name}`);
            setUndoAction(null);
        }
    };

    const handleSwipeUpAction = async () => {
        if (!currentAsset) return;
        
        const albumIdMatch = source.match(/^album_(.+)$/);
        if (albumIdMatch) {
            // In an album view: Remove from album
            const albumId = albumIdMatch[1];
            setToastMessage('Removed from Album');
            setUndoAction(() => async () => {
                await RemoteAlbumService.addAssetToAlbum(albumId, currentAsset.hash);
                setToastMessage('Restored to Album');
                setUndoAction(null);
            });
            
            try {
                await RemoteAlbumService.removeAssetFromAlbum(albumId, currentAsset.hash);
                DeviceEventEmitter.emit('assetRemovedFromAlbum', { albumId, hash: currentAsset.hash });
                
                // Optimistically update local view
                const newAssets = assets.filter(a => a.hash !== currentAsset.hash);
                if (newAssets.length === 0) {
                    navigation.goBack();
                } else {
                    GalleryStore.setAssets(newAssets, source);
                    setAssets(newAssets);
                    if (currentIndex >= newAssets.length) {
                        const newIndex = newAssets.length - 1;
                        setCurrentIndex(newIndex);
                        // Fix blank screen: force FlatList to scroll to the new last item
                        setTimeout(() => {
                            flatListRef.current?.scrollToIndex({ index: newIndex, animated: false });
                        }, 50);
                    }
                }
            } catch (e) {
                setToastMessage('Failed to remove');
                setUndoAction(null);
            }
        } else {
            // In regular gallery: prompt to delete
            handleDelete();
        }
    };

    useEffect(() => {
        swipeActionRef.current = handleSwipeUpAction;
    });

    const handleFindSimilar = () => {
        if (!currentAsset) return;
        navigation.navigate('MainTabs', {
            screen: 'Photos',
            params: {
                searchImageId: currentAsset.id,
                searchImageFilename: currentAsset.filename || '图片'
            }
        });
    };

    const handleShare = async () => {
        if (!currentAsset || isSharing) return;
        
        try {
            setIsSharing(true);
            const isAvailable = await Sharing.isAvailableAsync();
            if (!isAvailable) {
                Alert.alert("Sharing isn't available on your platform");
                return;
            }

            let uriToShare = currentAsset.uri;

            if (currentAsset.status === 'remote' && currentAsset.hash) {
                const remoteUrl = `${AuthService.getServerUrl()}/asset/${currentAsset.hash}?token=${AuthService.getToken()}`;
                const extension = currentAsset.name ? currentAsset.name.split('.').pop() : (currentAsset.mediaType === 'video' ? 'mp4' : 'jpg');
                const fileUri = FileSystem.cacheDirectory + `share_${currentAsset.hash}.${extension}`;
                
                const info = await FileSystem.getInfoAsync(fileUri);
                if (!info.exists) {
                    await FileSystem.downloadAsync(remoteUrl, fileUri);
                }
                uriToShare = fileUri;
            }

            await Sharing.shareAsync(uriToShare);

        } catch (error) {
            console.error('Error sharing:', error);
            Alert.alert("Share Error", error.message);
        } finally {
            setIsSharing(false);
        }
    };

    const handleUpload = async () => {
        if (!currentAsset || currentAsset.status === 'remote' || currentAsset.status === 'synced') return;
        
        setIsUploading(true);
        setUploadProgress(0);
        try {
            const result = await UploadService.uploadAsset(currentAsset, (progressData) => {
                const fraction = typeof progressData === 'object' ? progressData.fraction : progressData;
                setUploadProgress(fraction);
            });
            if (result.success) {
                // Update local state and store
                const updatedAsset = { ...currentAsset, status: 'synced', hash: result.hash };
                const newAssets = [...assets];
                newAssets[currentIndex] = updatedAsset;
                GalleryStore.setAssets(newAssets, source);
                setAssets(newAssets);
                DeviceEventEmitter.emit('assetUpdated', updatedAsset);
                
                // If it wasn't a duplicate, we should theoretically update the Merkle tree
                // but for now, the UI update is enough. The next background sync will fix the tree.
                Alert.alert("Success", "Photo uploaded successfully!");
            }
        } catch (e) {
            Alert.alert("Upload Failed", e.message);
        } finally {
            setIsUploading(false);
        }
    };

    const handleDelete = async () => {
        if (!currentAsset || !currentAsset.id) return;
        
        const executeDelete = async (scope) => {
            try {
                let isFullyDeleted = false;
                let newStatus = currentAsset.status;

                if (scope === 'local' || scope === 'both') {
                    await MediaService.deleteLocalAsset(currentAsset.id);
                    if (currentAsset.status === 'local' || scope === 'both') isFullyDeleted = true;
                    else if (currentAsset.status === 'synced') newStatus = 'remote';
                }
                
                if (scope === 'remote' || scope === 'both') {
                    await MediaService.deleteRemoteAsset(currentAsset.hash || currentAsset.id, !!currentAsset.hash);
                    if (currentAsset.hash) {
                        await SyncService.removeRemoteAsset(currentAsset.hash);
                    }
                    if (currentAsset.status === 'remote' || scope === 'both') isFullyDeleted = true;
                    else if (currentAsset.status === 'synced') newStatus = 'local';
                }
                
                if (isFullyDeleted) {
                    // Delete from local SQLite
                    await AssetDBService.deleteAsset(currentAsset.id);
                    if (currentAsset.hash) {
                        await AssetDBService.deleteAsset(currentAsset.hash);
                    }

                    const newAssets = assets.filter(a => a.id !== currentAsset.id);
                    GalleryStore.setAssets(newAssets, source);
                    setAssets(newAssets);
                    DeviceEventEmitter.emit('assetDeleted', currentAsset.id);
                    
                    if (newAssets.length === 0) {
                        if (navigation.canGoBack()) navigation.goBack();
                    } else if (currentIndex >= newAssets.length) {
                        setCurrentIndex(newAssets.length - 1);
                    }
                } else {
                    // Update isLocal status in SQLite
                    const db = AssetDBService.db;
                    if (db) {
                        if (newStatus === 'remote') {
                            await db.runAsync('UPDATE MediaAsset SET isLocal = 0 WHERE id = ? OR hash = ?', [currentAsset.id, currentAsset.hash || currentAsset.id]);
                        } else if (newStatus === 'local') {
                            await db.runAsync('UPDATE MediaAsset SET isLocal = 1 WHERE id = ? OR hash = ?', [currentAsset.id, currentAsset.hash || currentAsset.id]);
                        }
                    }

                    const updatedAsset = { ...currentAsset, status: newStatus };
                    if (newStatus === 'remote' && currentAsset.hash) {
                         // Switch URI to the backend because the local file is now physically destroyed
                         const baseUrl = AuthService.getServerUrl();
                         const token = AuthService.getToken();
                         updatedAsset.uri = `${baseUrl}/preview/${currentAsset.hash}?width=320&height=-1&token=${token}`;
                    }

                    const newAssets = [...assets];
                    newAssets[currentIndex] = updatedAsset;
                    GalleryStore.setAssets(newAssets, source);
                    setAssets(newAssets);
                    DeviceEventEmitter.emit('assetUpdated', updatedAsset);
                }
            } catch (e) {
                Alert.alert("Error", "Deletion failed: " + e.message);
            }
        };

        if (currentAsset.status === 'local') {
            Alert.alert("Delete Photo", "Delete this item from your device?", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => executeDelete('local') }
            ]);
        } else if (currentAsset.status === 'remote') {
            Alert.alert("Delete Photo", "Delete this item from Lomorage backup?", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => executeDelete('remote') }
            ]);
        } else if (currentAsset.status === 'synced') {
            Alert.alert("Delete Photo", "Delete this item from device and Lomorage backup?", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete from Backup", style: "destructive", onPress: () => executeDelete('remote') },
                { text: "Delete from Device", style: "destructive", onPress: () => executeDelete('local') },
                { text: "Delete from Both", style: "destructive", onPress: () => executeDelete('both') }
            ]);
        }
    };

    const handleTrashPress = () => {
        handleDelete();
    };

    const onViewableItemsChanged = useRef(({ viewableItems }) => {
        if (viewableItems.length > 0) {
            const newIndex = viewableItems[0].index;
            setCurrentIndex(prevIndex => {
                if (prevIndex !== newIndex) {
                    setUseOriginalVideo(false);
                    return newIndex;
                }
                return prevIndex;
            });
        }
    }).current;

    const handlePressIn = useCallback((isLive, liveVideoUri) => {
        if (isLive && liveVideoUri) {
            try {
                Vibration.vibrate(10);
            } catch (e) {}

            scaleAnim.setValue(1);
            fadeAnim.setValue(0);
            setIsLivePlaying(true);

            Animated.parallel([
                Animated.spring(scaleAnim, {
                    toValue: 0.96,
                    useNativeDriver: true,
                    speed: 12,
                    bounciness: 4
                }),
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true
                })
            ]).start();
        }
    }, [scaleAnim, fadeAnim]);

    const handlePressOut = useCallback(() => {
        if (isLivePlaying) {
            Animated.parallel([
                Animated.spring(scaleAnim, {
                    toValue: 1.0,
                    useNativeDriver: true,
                    speed: 12,
                    bounciness: 4
                }),
                Animated.timing(fadeAnim, {
                    toValue: 0,
                    duration: 250,
                    useNativeDriver: true
                })
            ]).start((result) => {
                if (result.finished) {
                    setIsLivePlaying(false);
                }
            });
        }
    }, [isLivePlaying, scaleAnim, fadeAnim]);

    const renderItem = ({ item, index }) => {
        // Always derive the URI fresh from AuthService so a stale/rotated token
        // in item.uri never silently breaks image loading.
        const baseUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        const assetId = item.hash || item.id;

        let uri;
        let isRemote = false;

        if (item.status === 'remote') {
            isRemote = true;
            // Use /asset/ for full resolution in the detail view.
            // For videos, append &ext=mp4 so the player gets a streamable container.
            uri = `${baseUrl}/asset/${assetId}?token=${token}`;
            if (item.mediaType === 'video') {
                uri += '&ext=mp4';
                // Only apply HD to the currently visible video to save bandwidth
                if (useOriginalVideo && index === currentIndex) {
                    uri += '&orig=1';
                }
                // (Proxy conversion is now handled asynchronously inside AssetVideoPlayer)
            }
        } else {
            uri = MediaService.normalizeUri(item.uri);
        }

        const isVisible = index === currentIndex;

        // Unmount video players when not visible to guarantee playback stops.
        const shouldMountVideo = item.mediaType === 'video' && isVisible;
        const isLive = isLivePhoto(item);
        const cacheKey = getCacheKey(item);
        const liveVideoUri = extractedVideoUris[cacheKey];
        const shouldPlayLive = isLive && isLivePlaying && isVisible && liveVideoUri;

        // Remote videos are converted to proxy URLs synchronously to prevent mount/frame flash
        // Only use the video cache proxy on physical devices, as it fails on Simulators/Emulators
        let resolvedVideoUri = uri;
        if (item.status === 'remote' && item.mediaType === 'video' && !isLive && Device.isDevice) {
            try {
                resolvedVideoUri = convertToProxyURL(uri);
            } catch (e) {
                console.warn(`[AssetDetail] Failed to resolve proxy synchronously for index ${index}:`, e);
            }
        }

        if (item.mediaType === 'video') {
            console.log(`[AssetDetail] renderItem index=${index}: isVisible=${isVisible}, shouldMountVideo=${shouldMountVideo}, resolvedVideoUri=${resolvedVideoUri}`);
        }

        let thumbUri = (item.status === 'remote' && item.hash)
            ? `${baseUrl}/preview/${item.hash}?width=320&height=-1&token=${token}`
            : null;

        let staticImageUri = uri;
        if (isRemote && item.hash) {
            if (item.mediaType === 'video') {
                staticImageUri = thumbUri;
            } else {
                // Fetch original asset for full screen viewing to avoid expensive server transcoding
                staticImageUri = `${baseUrl}/asset/${item.hash}?token=${token}`;
            }
        } else if (!isRemote && item.mediaType === 'video' && Platform.OS === 'android' && staticImageUri && staticImageUri.startsWith('content://')) {
            staticImageUri = `${staticImageUri}/thumbnail`;
        }
        // Offline Cache overriding logic:
        if (item.status === 'remote' && item.localCachePath) {
            thumbUri = item.localCachePath;
            if (item.mediaType !== 'video') {
                staticImageUri = item.localCachePath;
            }
        }

        return (
            <View style={{ width, height: height * 0.7, justifyContent: 'center', alignItems: 'center', position: 'relative', backgroundColor: '#fff' }}>
                <ZoomableMedia 
                    onZoomStateChange={(isZoomed) => setFlatListScrollEnabled(!isZoomed)}
                    style={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}
                >
                    {item.mediaType === 'video' && !isLive ? (
                        <View style={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
                            {/* The instantly-loading thumbnail from disk cache ALWAYS mounted to prevent flash */}
                            <Image
                                source={{ uri: staticImageUri }}
                                placeholder={thumbUri ? { uri: thumbUri } : null}
                                placeholderContentFit="contain"
                                style={[styles.image, { position: 'absolute' }]}
                                contentFit="contain"
                                cachePolicy="memory-disk"
                                transition={0}
                            />
                            {/* The streaming video player layered on top, only mounted when visible and proxy url resolved */}
                            {shouldMountVideo && resolvedVideoUri && (
                                <AssetVideoPlayer 
                                    key={resolvedVideoUri}
                                    uri={resolvedVideoUri} 
                                    style={[styles.image, { position: 'absolute' }]} 
                                    shouldPlay={isVisible}
                                    nativeControls={true}
                                />
                            )}
                        </View>
                    ) : (
                        <Pressable
                            style={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', position: 'relative' }}
                            onPressIn={() => handlePressIn(isLive, liveVideoUri)}
                            onPressOut={handlePressOut}
                        >
                            <Animated.View style={{
                                width: '100%',
                                height: '100%',
                                justifyContent: 'center',
                                alignItems: 'center',
                                transform: [{ scale: scaleAnim }]
                            }}>
                                {/* Static Image with native placeholder scaled to fit */}
                                <Image
                                    source={{ uri: staticImageUri }}
                                    placeholder={thumbUri ? { uri: thumbUri } : null}
                                    placeholderContentFit="contain"
                                    style={styles.image}
                                    contentFit="contain"
                                    cachePolicy="memory-disk"
                                    transition={0}
                                />

                                {/* Looping Video Player is absolute positioned on top of the Image when playing */}
                                {shouldPlayLive ? (
                                    <Animated.View style={[StyleSheet.absoluteFill, { opacity: fadeAnim }]}>
                                        <AssetVideoPlayer 
                                            key={liveVideoUri}
                                            uri={liveVideoUri} 
                                            style={styles.image} 
                                            shouldPlay={true}
                                            nativeControls={false}
                                        />
                                    </Animated.View>
                                ) : null}
                            </Animated.View>
                        </Pressable>
                    )}
                </ZoomableMedia>
                {isLive ? (
                    <View style={styles.liveBadgeContainer}>
                        {isPreparingLive && isVisible ? (
                            <ActivityIndicator size="small" color="#fff" style={{ marginRight: 6 }} />
                        ) : (
                            <LivePhotoIcon size={14} color="#fff" />
                        )}
                        <Text style={styles.liveBadgeText}>
                            {isPreparingLive && isVisible ? 'LIVE • LOADING...' : 'LIVE'}
                        </Text>
                    </View>
                ) : null}
            </View>
        );
    };

    return (
        <View style={styles.container} {...panResponder.panHandlers}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.canGoBack() && navigation.goBack()} style={styles.iconButton}>
                    <ChevronLeft color="#000" size={28} />
                </TouchableOpacity>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {currentAsset.mediaType === 'video' && currentAsset.status === 'remote' ? (
                        <TouchableOpacity 
                            onPress={() => setUseOriginalVideo(!useOriginalVideo)}
                            style={[
                                styles.qualityToggle, 
                                useOriginalVideo ? styles.qualityToggleActive : styles.qualityToggleInactive
                            ]}
                            activeOpacity={0.7}
                        >
                            <Text style={useOriginalVideo ? styles.qualityTextActive : styles.qualityTextInactive}>
                                {useOriginalVideo ? 'HD' : 'SD'}
                            </Text>
                        </TouchableOpacity>
                    ) : null}
                    {currentAsset.status === 'local' ? (
                        <TouchableOpacity 
                            onPress={handleUpload} 
                            style={styles.iconButton}
                            disabled={isUploading}
                        >
                            <CloudUpload color={isUploading ? "#ccc" : "#007AFF"} size={24} />
                        </TouchableOpacity>
                    ) : null}
                    {currentAsset.status === 'remote' || currentAsset.status === 'synced' ? (
                        <TouchableOpacity onPress={handleToggleFavorite} style={styles.iconButton}>
                            <Heart color={isFavorite ? "#ef4444" : "#007AFF"} fill={isFavorite ? "#ef4444" : "transparent"} size={24} />
                        </TouchableOpacity>
                    ) : null}
                    
                    {/* Find Similar Photos */}
                    <TouchableOpacity onPress={handleFindSimilar} style={styles.iconButton}>
                        <Sparkles color="#007AFF" size={24} />
                    </TouchableOpacity>
                    
                    <TouchableOpacity onPress={handleShare} style={styles.iconButton} disabled={isSharing}>
                        {isSharing ? (
                            <ActivityIndicator size="small" color="#007AFF" />
                        ) : (
                            <Share color="#007AFF" size={24} />
                        )}
                    </TouchableOpacity>
                    {source.startsWith('album_') && (
                        <TouchableOpacity onPress={handleSwipeUpAction} style={styles.iconButton}>
                            <FolderMinus color="#ff9500" size={24} />
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={handleTrashPress} style={styles.iconButton}>
                        <Trash2 color="#ef4444" size={24} />
                    </TouchableOpacity>
                </View>
            </View>

            <View style={styles.imageContainer}>
                {assets.length > 0 ? (
                    <FlatList
                        ref={flatListRef}
                        data={assets}
                        keyExtractor={item => item.id}
                        horizontal
                        pagingEnabled
                        scrollEnabled={flatListScrollEnabled}
                        showsHorizontalScrollIndicator={false}
                        initialScrollIndex={Math.min(initialIndex, assets.length - 1)}
                        getItemLayout={(data, index) => ({ length: width, offset: width * index, index })}
                        onViewableItemsChanged={onViewableItemsChanged}
                        viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
                        renderItem={renderItem}
                        windowSize={5}
                        extraData={{ useOriginalVideo, currentIndex, isLivePlaying, isPreparingLive, extractedVideoUris }}
                        style={{ backgroundColor: '#fff' }}
                    />
                ) : null}
            </View>

            <View style={styles.footer}>
                <Text style={styles.infoText}>{currentAsset.filename}</Text>
                <Text style={styles.subInfoText}>
                    {new Date(currentAsset.creationTime || 0).toLocaleString()}
                </Text>
            </View>

            {userAlbums.length > 0 && (
                <View style={styles.slideboxContainer}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.slideboxScroll}>
                        {userAlbums.map((album, idx) => (
                            <TouchableOpacity 
                                key={idx} 
                                style={styles.slideboxAlbum}
                                onPress={() => handleAddToAlbum(album)}
                            >
                                <Text style={styles.slideboxAlbumText} numberOfLines={1}>{album.data.name}</Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>
                </View>
            )}

            {toastMessage && (
                <View style={styles.toastContainer}>
                    <Text style={styles.toastText}>{toastMessage}</Text>
                    {undoAction && (
                        <TouchableOpacity onPress={undoAction} style={styles.undoBtn}>
                            <Text style={styles.undoBtnText}>UNDO</Text>
                        </TouchableOpacity>
                    )}
                </View>
            )}

            {isUploading && (
                <View style={styles.progressOverlay}>
                    <Text style={styles.progressText}>Uploading... {Math.round(uploadProgress * 100)}%</Text>
                    <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: `${uploadProgress * 100}%` }]} />
                    </View>
                </View>
            )}

            {debugMode && currentAsset.id ? (
                <View style={styles.debugPanel}>
                    <Text style={styles.debugTitle}>--- ASSET DEBUG ---</Text>
                    <Text selectable style={styles.debugText}>ID: {currentAsset.id}</Text>
                    <Text selectable style={styles.debugText}>Hash: {currentAsset.hash || 'MISSING'}</Text>
                    <Text selectable style={styles.debugText}>Status: {currentAsset.status}</Text>
                    <Text selectable style={styles.debugText}>Time Ms: {currentAsset.creationTime}</Text>
                    <Text selectable style={styles.debugText}>UTC: {new Date(currentAsset.creationTime).toISOString()}</Text>
                    <Text selectable style={styles.debugText}>Index: {currentIndex} / {assets.length}</Text>
                </View>
            ) : null}
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
        justifyContent: 'space-between',
        paddingTop: 10,
        paddingHorizontal: 15,
        paddingBottom: 10,
        backgroundColor: 'rgba(255,255,255,0.9)',
    },
    iconButton: {
        padding: 8,
    },
    imageContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#fff',
    },
    image: {
        width: width,
        height: height * 0.7,
        backgroundColor: '#fff',
    },
    footer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: '#f9f9f9',
    },
    infoText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
    },
    subInfoText: {
        fontSize: 14,
        color: '#666',
        marginTop: 4,
    },
    slideboxContainer: {
        height: 60,
        backgroundColor: '#fff',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#e5e5ea',
        justifyContent: 'center',
    },
    slideboxScroll: {
        paddingHorizontal: 12,
        alignItems: 'center',
    },
    slideboxAlbum: {
        backgroundColor: '#f2f2f7',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
        marginHorizontal: 4,
    },
    slideboxAlbumText: {
        fontSize: 14,
        fontWeight: '500',
        color: '#1c1c1e',
    },
    toastContainer: {
        position: 'absolute',
        bottom: 160,
        alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,0.85)',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 24,
        zIndex: 1000,
        flexDirection: 'row',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 5,
        elevation: 6,
    },
    toastText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '500',
    },
    undoBtn: {
        marginLeft: 16,
        paddingLeft: 16,
        borderLeftWidth: 1,
        borderLeftColor: 'rgba(255,255,255,0.3)',
    },
    undoBtnText: {
        color: '#ff9500',
        fontWeight: 'bold',
        fontSize: 15,
    },
    progressOverlay: {
        position: 'absolute',
        bottom: 100,
        left: 20,
        right: 20,
        backgroundColor: 'rgba(0,0,0,0.85)',
        padding: 15,
        borderRadius: 12,
        alignItems: 'center',
    },
    progressText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: 8,
    },
    progressBarBg: {
        height: 6,
        width: '100%',
        backgroundColor: '#444',
        borderRadius: 3,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: '#007AFF',
    },
    debugPanel: {
        position: 'absolute',
        top: 100,
        left: 20,
        right: 20,
        backgroundColor: 'rgba(0,0,0,0.85)',
        padding: 15,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#0f0',
    },
    debugTitle: {
        color: '#0f0',
        fontWeight: 'bold',
        fontSize: 14,
        marginBottom: 8,
        textAlign: 'center',
    },
    debugText: {
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: 11,
        marginBottom: 4,
    },
    qualityToggle: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderRadius: 16,
        marginRight: 15,
        borderWidth: 1,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 1,
        elevation: 2,
    },
    qualityToggleActive: {
        backgroundColor: '#007AFF',
        borderColor: '#007AFF',
    },
    qualityToggleInactive: {
        backgroundColor: '#fff',
        borderColor: '#d1d5db',
    },
    qualityTextActive: {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#fff',
    },
    qualityTextInactive: {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#4b5563',
    },
    liveBadgeContainer: {
        position: 'absolute',
        top: 20,
        left: 20,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 14,
        borderWidth: 0.5,
        borderColor: 'rgba(255, 255, 255, 0.25)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 3,
        elevation: 4,
    },
    liveBadgeText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: 'bold',
        marginLeft: 6,
        letterSpacing: 1,
    }
});
