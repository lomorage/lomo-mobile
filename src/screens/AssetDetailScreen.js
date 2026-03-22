import React, { useState } from 'react';
import { StyleSheet, View, Image, Dimensions, TouchableOpacity, Text, ScrollView } from 'react-native';
import { ChevronLeft, Upload } from 'lucide-react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import AuthService from '../services/AuthService';
import { useSettings } from '../context/SettingsContext';

const { width, height } = Dimensions.get('window');

function AssetVideoPlayer({ uri, style }) {
    const player = useVideoPlayer(uri, player => {
        player.loop = true;
        player.play();
    });

    return (
        <VideoView 
            style={style} 
            player={player}
            allowsPictureInPicture 
        />
    );
}

export default function AssetDetailScreen({ route, navigation }) {
    const { asset } = route.params;
    const { debugMode } = useSettings();
    const [useOriginalVideo, setUseOriginalVideo] = useState(false);

    let uri = asset.uri;
    // We must overwrite the URI if it's missing, missing a token, or is a /preview/ thumbnail
    if (asset.status === 'remote' && (!uri || !uri.includes('token=') || uri.includes('/preview/'))) {
        const baseUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        const assetId = asset.hash || asset.id;
        // Append &ext=mp4 so ExoPlayer can infer the MIME type from the URL string
        uri = `${baseUrl}/asset/${assetId}?token=${token}&ext=mp4`;
        
        if (useOriginalVideo && asset.mediaType === 'video') {
            uri += '&orig=1';
        }
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
                    <ChevronLeft color="#000" size={28} />
                </TouchableOpacity>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {asset.mediaType === 'video' && asset.status === 'remote' && (
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
                {asset.mediaType === 'video' ? (
                    <AssetVideoPlayer uri={uri} style={styles.image} />
                ) : (
                    <Image
                        source={{ uri }}
                        style={styles.image}
                        resizeMode="contain"
                        onError={(e) => console.log(`[AssetDetail] Image load error for ${asset.status} asset ${asset.id}:`, e.nativeEvent.error)}
                    />
                )}
            </View>

            <View style={styles.footer}>
                <Text style={styles.infoText}>{asset.filename}</Text>
                <Text style={styles.subInfoText}>
                    {new Date(asset.creationTime).toLocaleString()}
                </Text>
            </View>

            {/* FULL DEBUG PANEL */}
            {debugMode && (
                <View style={styles.debugPanel}>
                    <Text style={styles.debugTitle}>--- ASSET DEBUG ---</Text>
                    <Text selectable style={styles.debugText}>ID: {asset.id}</Text>
                    <Text selectable style={styles.debugText}>Hash: {asset.hash || 'MISSING'}</Text>
                    <Text selectable style={styles.debugText}>Status: {asset.status}</Text>
                    <Text selectable style={styles.debugText}>Time Ms: {asset.creationTime}</Text>
                    <Text selectable style={styles.debugText}>UTC: {new Date(asset.creationTime).toISOString()}</Text>
                    <Text selectable style={styles.debugText}>URI: {uri?.substring(0, 30)}...</Text>
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
