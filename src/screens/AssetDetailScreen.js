import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StyleSheet, View, Dimensions, TouchableOpacity, Text, FlatList, Alert, DeviceEventEmitter, Pressable, ActivityIndicator, Animated, Vibration } from 'react-native';
import { Image } from 'expo-image';
import { ChevronLeft, Upload, Trash2 } from 'lucide-react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import AuthService from '../services/AuthService';
import MediaService from '../services/MediaService';
import SyncService from '../services/SyncService';
import UploadService from '../services/UploadService';
import { useSettings } from '../context/SettingsContext';
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

function AssetVideoPlayer({ uri, style, shouldPlay, nativeControls = false }) {
    const player = useVideoPlayer(uri, player => {
        player.loop = !nativeControls; // Loop if no controls (Live Photos), otherwise standard playback
    });

    useEffect(() => {
        if (shouldPlay) {
            player.play();
        } else {
            player.pause();
        }
    }, [shouldPlay, player]);

    return (
        <VideoView 
            style={style} 
            player={player}
            allowsPictureInPicture 
            nativeControls={nativeControls}
        />
    );
}

export default function AssetDetailScreen({ route, navigation }) {
    const { initialIndex } = route.params;
    const [assets, setAssets] = useState(GalleryStore.getAssets());
    
    const { debugMode } = useSettings();
    const [useOriginalVideo, setUseOriginalVideo] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
    const [extractedVideoUris, setExtractedVideoUris] = useState({});
    const [isPreparingLive, setIsPreparingLive] = useState(false);
    const [isLivePlaying, setIsLivePlaying] = useState(false);
    const [flatListScrollEnabled, setFlatListScrollEnabled] = useState(true);
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const fadeAnim = useRef(new Animated.Value(0)).current;

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

    const handleUpload = async () => {
        if (!currentAsset || currentAsset.status === 'remote' || currentAsset.status === 'synced') return;
        
        setIsUploading(true);
        setUploadProgress(0);
        try {
            const result = await UploadService.uploadAsset(currentAsset, (progress) => {
                setUploadProgress(progress);
            });
            if (result.success) {
                // Update local state and store
                const updatedAsset = { ...currentAsset, status: 'synced', hash: result.hash };
                const newAssets = [...assets];
                newAssets[currentIndex] = updatedAsset;
                GalleryStore.setAssets(newAssets);
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
                    const newAssets = assets.filter(a => a.id !== currentAsset.id);
                    GalleryStore.setAssets(newAssets);
                    setAssets(newAssets);
                    DeviceEventEmitter.emit('assetDeleted', currentAsset.id);
                    
                    if (newAssets.length === 0) {
                        navigation.goBack();
                    } else if (currentIndex >= newAssets.length) {
                        setCurrentIndex(newAssets.length - 1);
                    }
                } else {
                    const updatedAsset = { ...currentAsset, status: newStatus };
                    if (newStatus === 'remote' && currentAsset.hash) {
                         // Switch URI to the backend because the local file is now physically destroyed
                         const baseUrl = AuthService.getServerUrl();
                         const token = AuthService.getToken();
                         updatedAsset.uri = `${baseUrl}/preview/${currentAsset.hash}?width=500&height=-1&token=${token}`;
                    }

                    const newAssets = [...assets];
                    newAssets[currentIndex] = updatedAsset;
                    GalleryStore.setAssets(newAssets);
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
            Alert.alert("Delete Photo", "Where would you like to delete this from?", [
                { text: "Device Only", onPress: () => executeDelete('local') },
                { text: "Lomorage Only", onPress: () => executeDelete('remote') },
                { text: "Both", style: "destructive", onPress: () => executeDelete('both') }
            ], { cancelable: true });
        }
    };

    const onViewableItemsChanged = useRef(({ viewableItems }) => {
        if (viewableItems.length > 0) {
            const newIndex = viewableItems[0].index;
            if (newIndex !== currentIndex) {
                setCurrentIndex(newIndex);
                setUseOriginalVideo(false);
            }
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
            }
        } else {
            uri = MediaService.normalizeUri(item.uri);
        }

        const isVisible = index === currentIndex;

        // Prevent Android OutOfMemoryError (MediaCodec): Unmount ExoPlayer for off-screen videos
        const shouldMountVideo = item.mediaType === 'video' && isVisible;
        const isLive = isLivePhoto(item);
        const cacheKey = getCacheKey(item);
        const liveVideoUri = extractedVideoUris[cacheKey];
        const shouldPlayLive = isLive && isLivePlaying && isVisible && liveVideoUri;

        const staticImageUri = (isRemote && isLive)
            ? item.uri
            : ((item.mediaType === 'video' && isRemote) ? item.uri : uri);

        return (
            <View style={{ width, height: height * 0.7, justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
                <ZoomableMedia 
                    onZoomStateChange={(isZoomed) => setFlatListScrollEnabled(!isZoomed)}
                    style={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}
                >
                    {shouldMountVideo && !isLive ? (
                        <View style={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
                            {/* The instantly-loading thumbnail from disk cache */}
                            <Image
                                source={{ uri: staticImageUri }}
                                style={[styles.image, { position: 'absolute' }]}
                                contentFit="contain"
                                cachePolicy="disk"
                                transition={150}
                            />
                            {/* The streaming video player layered on top */}
                            <AssetVideoPlayer 
                                uri={uri} 
                                style={[styles.image, { position: 'absolute' }]} 
                                shouldPlay={isVisible}
                                nativeControls={true}
                            />
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
                                {/* Static Image is ALWAYS rendered as the base background layer */}
                                <Image
                                    source={{ uri: staticImageUri }}
                                    style={styles.image}
                                    contentFit="contain"
                                    cachePolicy="disk"
                                    transition={150}
                                />

                                {/* Looping Video Player is absolute positioned on top of the Image when playing */}
                                {shouldPlayLive ? (
                                    <Animated.View style={[StyleSheet.absoluteFill, { opacity: fadeAnim }]}>
                                        <AssetVideoPlayer 
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
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
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
                            <Upload color={isUploading ? "#ccc" : "#007AFF"} size={24} />
                        </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={handleDelete} style={styles.iconButton}>
                        <Trash2 color="#ef4444" size={24} />
                    </TouchableOpacity>
                </View>
            </View>

            <View style={styles.imageContainer}>
                {assets.length > 0 ? (
                    <FlatList
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
                    />
                ) : null}
            </View>

            <View style={styles.footer}>
                <Text style={styles.infoText}>{currentAsset.filename}</Text>
                <Text style={styles.subInfoText}>
                    {new Date(currentAsset.creationTime || 0).toLocaleString()}
                </Text>
            </View>

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
    },
    image: {
        width: width,
        height: height * 0.7,
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
