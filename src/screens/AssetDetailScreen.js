import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StyleSheet, View, Image, Dimensions, TouchableOpacity, Text, FlatList } from 'react-native';
import { ChevronLeft, Upload } from 'lucide-react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import AuthService from '../services/AuthService';
import { useSettings } from '../context/SettingsContext';
import GalleryStore from '../store/GalleryStore';

const { width, height } = Dimensions.get('window');

function AssetVideoPlayer({ uri, style, shouldPlay }) {
    const player = useVideoPlayer(uri, player => {
        player.loop = true;
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
        />
    );
}

export default function AssetDetailScreen({ route, navigation }) {
    const { initialIndex } = route.params;
    const assets = GalleryStore.getAssets();
    
    const { debugMode } = useSettings();
    const [useOriginalVideo, setUseOriginalVideo] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
    
    const currentAsset = assets[currentIndex] || {};

    const onViewableItemsChanged = useRef(({ viewableItems }) => {
        if (viewableItems.length > 0) {
            const newIndex = viewableItems[0].index;
            if (newIndex !== currentIndex) {
                setCurrentIndex(newIndex);
                setUseOriginalVideo(false);
            }
        }
    }).current;

    const renderItem = ({ item, index }) => {
        let uri = item.uri;
        if (item.status === 'remote' && (!uri || !uri.includes('token=') || uri.includes('/preview/'))) {
            const baseUrl = AuthService.getServerUrl();
            const token = AuthService.getToken();
            const assetId = item.hash || item.id;
            uri = `${baseUrl}/asset/${assetId}?token=${token}&ext=mp4`;
            
            // Only apply HD to the currently active video to save bandwidth
            if (useOriginalVideo && item.mediaType === 'video' && index === currentIndex) {
                uri += '&orig=1';
            }
        }

        const isVisible = index === currentIndex;

        return (
            <View style={{ width, height: height * 0.7, justifyContent: 'center', alignItems: 'center' }}>
                {item.mediaType === 'video' ? (
                    <AssetVideoPlayer uri={uri} style={styles.image} shouldPlay={isVisible} />
                ) : (
                    <Image
                        source={{ uri }}
                        style={styles.image}
                        resizeMode="contain"
                    />
                )}
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
                    {currentAsset.mediaType === 'video' && currentAsset.status === 'remote' && (
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
                    )}
                    <TouchableOpacity style={styles.iconButton}>
                        <Upload color="#007AFF" size={24} />
                    </TouchableOpacity>
                </View>
            </View>

            <View style={styles.imageContainer}>
                <FlatList
                    data={assets}
                    keyExtractor={item => item.id}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    initialScrollIndex={initialIndex}
                    getItemLayout={(data, index) => ({ length: width, offset: width * index, index })}
                    onViewableItemsChanged={onViewableItemsChanged}
                    viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
                    renderItem={renderItem}
                    windowSize={5}
                    extraData={{ useOriginalVideo, currentIndex }}
                />
            </View>

            <View style={styles.footer}>
                <Text style={styles.infoText}>{currentAsset.filename}</Text>
                <Text style={styles.subInfoText}>
                    {new Date(currentAsset.creationTime || 0).toLocaleString()}
                </Text>
            </View>

            {debugMode && currentAsset.id && (
                <View style={styles.debugPanel}>
                    <Text style={styles.debugTitle}>--- ASSET DEBUG ---</Text>
                    <Text selectable style={styles.debugText}>ID: {currentAsset.id}</Text>
                    <Text selectable style={styles.debugText}>Hash: {currentAsset.hash || 'MISSING'}</Text>
                    <Text selectable style={styles.debugText}>Status: {currentAsset.status}</Text>
                    <Text selectable style={styles.debugText}>Time Ms: {currentAsset.creationTime}</Text>
                    <Text selectable style={styles.debugText}>UTC: {new Date(currentAsset.creationTime).toISOString()}</Text>
                    <Text selectable style={styles.debugText}>Index: {currentIndex} / {assets.length}</Text>
                </View>
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
    }
});
