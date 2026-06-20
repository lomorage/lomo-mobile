import React from 'react';
import { StyleSheet, View, ScrollView, Text, Switch, TouchableOpacity, Alert, ActivityIndicator, Platform, Modal, TextInput, DeviceEventEmitter, FlatList, Dimensions, Pressable } from 'react-native';
import { ChevronLeft, Trash2, RefreshCcw, Server, ChevronRight, Globe } from 'lucide-react-native';
import Constants from 'expo-constants';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';
import Logger from '../utils/logger';
import AIService from '../services/AIService';
import { Send, Folder, X, PlayCircle } from 'lucide-react-native';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';

const SimpleVideoPlayer = ({ uri, isActive }) => {
    const [showControls, setShowControls] = React.useState(false);
    const player = useVideoPlayer(uri, player => {
        player.loop = true;
    });

    React.useEffect(() => {
        const sub = player.addListener('statusChange', ({ status }) => {
            if (status === 'readyToPlay' && isActive) {
                try { player.play(); } catch(e) {}
            }
        });

        if (isActive) {
            try { player.play(); } catch(e) {}
            setTimeout(() => {
                if (isActive) {
                    try { player.play(); } catch(e) {}
                }
            }, 100);
        } else {
            player.pause();
            setShowControls(false);
        }
        
        return () => sub.remove();
    }, [isActive, player]);

    return (
        <View style={{ flex: 1 }}>
            <VideoView style={StyleSheet.absoluteFillObject} player={player} allowsFullscreen allowsPictureInPicture nativeControls={showControls} />
            {!showControls && (
                <Pressable
                    style={StyleSheet.absoluteFillObject}
                    onPress={() => setShowControls(true)}
                />
            )}
        </View>
    );
};

export default function SettingsScreen({ navigation }) {
    const { 
        debugMode, 
        toggleDebugMode, 
        autoBackupEnabled, 
        toggleAutoBackup, 
        wifiOnlyBackup, 
        toggleWifiOnly, 
        chargingOnlyBackup, 
        toggleChargingOnly, 
        nightBackupOnly, 
        toggleNightBackup,
        adaptiveConcurrencyEnabled,
        toggleAdaptiveConcurrency,
        hashConcurrency,
        updateHashConcurrency,
        uploadConcurrency,
        updateUploadConcurrency,
        excludedAlbums,
        toggleAlbumExclusion,
        remoteAIProcessingEnabled,
        toggleRemoteAIProcessing,
        searchThreshold,
        updateSearchThreshold,
        aiWifiOnly,
        toggleAIWifiOnly,
        aiChargingOnly,
        toggleAIChargingOnly,
        aiEnabled,
        toggleAIEnabled
    } = useSettings();
    const { logout } = useAuth();
    const [stats, setStats] = React.useState({ local: 0, remote: 0 });
    const [isScanning, setIsScanning] = React.useState(false);
    const [isPHashIndexing, setIsPHashIndexing] = React.useState(false);
    const [isCLIPIndexing, setIsCLIPIndexing] = React.useState(false);
    const [aiStatus, setAiStatus] = React.useState({ isProcessing: false, current: 0, total: 0, message: 'Idle' });
    const [isExportingLogs, setIsExportingLogs] = React.useState(false);
    const [serverUrl, setServerUrl] = React.useState(AuthService.getServerUrl());
    const [localUrl, setLocalUrl] = React.useState(AuthService.getLocalUrl());
    const [remoteUrl, setRemoteUrl] = React.useState(AuthService.getRemoteUrl());
    const [serverName, setServerName] = React.useState(AuthService.getServerName());
    const [serverVersion, setServerVersion] = React.useState('Loading...');
    const clientVersion = Constants.expoConfig?.version || '1.0.10';

    const [isRemoteModalVisible, setRemoteModalVisible] = React.useState(false);
    const [tempRemoteUrl, setTempRemoteUrl] = React.useState('');

    const [isReachable, setIsReachable] = React.useState(null);
    const [isAlbumModalVisible, setAlbumModalVisible] = React.useState(false);
    const [albumsList, setAlbumsList] = React.useState([]);

    const [isAlbumPreviewModalVisible, setAlbumPreviewModalVisible] = React.useState(false);
    const [previewAlbum, setPreviewAlbum] = React.useState(null);
    const [previewAssets, setPreviewAssets] = React.useState([]);
    const [previewLoading, setPreviewLoading] = React.useState(false);
    const [previewHasNextPage, setPreviewHasNextPage] = React.useState(false);
    const [previewEndCursor, setPreviewEndCursor] = React.useState(null);
    const [previewLoadingMore, setPreviewLoadingMore] = React.useState(false);
    const [selectedAssetIndexToView, setSelectedAssetIndexToView] = React.useState(null);

    const onViewableItemsChanged = React.useRef(({ viewableItems }) => {
        if (viewableItems.length > 0) {
            setSelectedAssetIndexToView(viewableItems[0].index);
        }
    }).current;
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 50 }).current;

    React.useEffect(() => {
        loadStats();
        checkServerReachability();
        fetchServerVersion();
        
        // Load initial status
        setAiStatus(AIService.getProcessingStatus());

        const sub = DeviceEventEmitter.addListener('onServerUrlChanged', (newUrl) => {
            setServerUrl(newUrl);
            setLocalUrl(AuthService.getLocalUrl());
            setRemoteUrl(AuthService.getRemoteUrl());
            checkServerReachability(newUrl);
        });

        const aiSub = DeviceEventEmitter.addListener('ai_processing_status', (status) => {
            setAiStatus(status);
        });

        return () => {
            sub.remove();
            aiSub.remove();
        };
    }, []);

    const fetchServerVersion = async () => {
        const ver = await AuthService.getServerVersion();
        setServerVersion(ver);
    };

    const loadAlbums = async () => {
        try {
            const { status } = await MediaLibrary.requestPermissionsAsync();
            if (status === 'granted') {
                const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
                // Filter out albums with 0 assets if possible (getAlbumsAsync doesn't always populate assetCount exactly, but we can sort)
                const sortedAlbums = albums.sort((a, b) => b.assetCount - a.assetCount);
                setAlbumsList(sortedAlbums);
            } else {
                Alert.alert("Permission Required", "Please grant photo library access to use selective backup.");
            }
        } catch (error) {
            console.error("Failed to load albums", error);
        }
    };

    const handlePreviewAlbum = async (album) => {
        setPreviewAlbum(album);
        setAlbumPreviewModalVisible(true);
        setPreviewLoading(true);
        setPreviewAssets([]);
        setPreviewHasNextPage(false);
        setPreviewEndCursor(null);
        try {
            const result = await MediaLibrary.getAssetsAsync({ 
                album: album.id, 
                first: 100,
                mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
                sortBy: [[MediaLibrary.SortBy.creationTime, false]]
            });
            setPreviewAssets(result.assets || []);
            setPreviewHasNextPage(result.hasNextPage);
            setPreviewEndCursor(result.endCursor);
        } catch (e) {
            console.error("Preview fail", e);
        } finally {
            setPreviewLoading(false);
        }
    };

    const loadMorePreviewAssets = async () => {
        if (!previewHasNextPage || previewLoadingMore || !previewAlbum) return;
        setPreviewLoadingMore(true);
        try {
            const result = await MediaLibrary.getAssetsAsync({ 
                album: previewAlbum.id, 
                first: 100, 
                after: previewEndCursor,
                mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
                sortBy: [[MediaLibrary.SortBy.creationTime, false]]
            });
            setPreviewAssets(prev => [...prev, ...(result.assets || [])]);
            setPreviewHasNextPage(result.hasNextPage);
            setPreviewEndCursor(result.endCursor);
        } catch (e) {
            console.error("Load more preview fail", e);
        } finally {
            setPreviewLoadingMore(false);
        }
    };

    const checkServerReachability = async (urlToCheck = serverUrl) => {
        if (!urlToCheck) {
            setIsReachable(false);
            return;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${urlToCheck}/`, {
                method: 'GET',
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            setIsReachable(response.status === 200 || response.status < 500);
        } catch (e) {
            console.log('[SettingsScreen] Server unreachable. Attempting smart dual-connection failover...');
            const success = await AuthService.determineBestConnection();
            if (success) {
                setServerUrl(AuthService.getServerUrl());
                setIsReachable(true);
            } else {
                setIsReachable(false);
            }
        }
    };

    const loadStats = async () => {
        const s = await SyncService.getCacheStats();
        setStats(s);
    };

    const formatSize = (bytes) => {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const handleReProbe = async () => {
        if (isScanning) return;
        setIsScanning(true);
        setIsReachable(null);
        try {
            const success = await AuthService.autoProbe();
            if (success) {
                const newUrl = AuthService.getServerUrl();
                setServerUrl(newUrl);
                setLocalUrl(AuthService.getLocalUrl());
                setRemoteUrl(AuthService.getRemoteUrl());
                setServerName(AuthService.getServerName());
                setIsReachable(true);
                Alert.alert("Server Found ✓", `Connected to:\n${newUrl}`);
            } else {
                setIsReachable(false);
                Alert.alert(
                    "Server Not Found",
                    "No Lomorage server was found on your local network.\n\nMake sure:\n• Your server is running\n• Your phone is on the same Wi-Fi"
                );
            }
        } catch (e) {
            setIsReachable(false);
            Alert.alert("Error", "Failed to probe network.");
        }
        setIsScanning(false);
    };

    const handleSaveRemoteUrl = async () => {
        let url = tempRemoteUrl.trim();
        if (url) {
            url = AuthService.formatUrl(url);
            
            const atsCheck = AuthService.checkIOSATS(url);
            if (!atsCheck.valid) {
                Alert.alert("iOS Security Restriction", atsCheck.message);
                return;
            }
        }
        await AuthService.setRemoteUrl(url);
        setRemoteUrl(AuthService.getRemoteUrl());
        setRemoteModalVisible(false);
        AuthService.determineBestConnection().then(() => {
            setServerUrl(AuthService.getServerUrl());
            checkServerReachability();
        });
    };

    const handleExportLogs = async () => {
        if (isExportingLogs) return;
        setIsExportingLogs(true);
        try {
            const token = await AuthService.getToken();
            const result = await Logger.exportLogs(serverUrl, token);
            if (result.success && !result.serverLogIncluded) {
                Alert.alert("Partial Success", "Client logs exported, but server logs could not be downloaded.");
            }
        } catch (error) {
            Alert.alert("Export Failed", "Could not package and export logs: " + error.message);
        } finally {
            setIsExportingLogs(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.canGoBack() && navigation.goBack()} style={styles.iconButton}>
                    <ChevronLeft color="#000" size={28} />
                </TouchableOpacity>
                <Text style={styles.title}>Settings</Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Backup Strategy</Text>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Auto-Backup</Text>
                        <Text style={styles.settingDescription}>Automatically scan and upload your new photos into the cloud.</Text>
                    </View>
                    <Switch
                        value={autoBackupEnabled}
                        onValueChange={toggleAutoBackup}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                <View style={[styles.settingRow, { opacity: autoBackupEnabled ? 1 : 0.5 }]}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Wi-Fi Only</Text>
                        <Text style={styles.settingDescription}>Pause auto-backup when on cellular data to save mobile bandwidth.</Text>
                    </View>
                    <Switch
                        value={wifiOnlyBackup}
                        onValueChange={toggleWifiOnly}
                        disabled={!autoBackupEnabled}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                <View style={[styles.settingRow, { opacity: autoBackupEnabled ? 1 : 0.5 }]}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Charging Only</Text>
                        <Text style={styles.settingDescription}>Upload only when the device is connected to a power source.</Text>
                    </View>
                    <Switch
                        value={chargingOnlyBackup}
                        onValueChange={toggleChargingOnly}
                        disabled={!autoBackupEnabled}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                <View style={[styles.settingRow, { opacity: autoBackupEnabled ? 1 : 0.5 }]}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Late-Night Backup (2 AM - 5 AM)</Text>
                        <Text style={styles.settingDescription}>Defer auto-uploads to late hours to save daytime network bandwidth and CPU.</Text>
                    </View>
                    <Switch
                        value={nightBackupOnly}
                        onValueChange={toggleNightBackup}
                        disabled={!autoBackupEnabled}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                <TouchableOpacity 
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8 }]}
                    onPress={() => {
                        loadAlbums();
                        setAlbumModalVisible(true);
                    }}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Selective Backup (Folders)</Text>
                        <Text style={styles.settingDescription}>Choose which albums/folders to back up or ignore (e.g. skip Screenshots).</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {excludedAlbums?.length > 0 && (
                            <Text style={{ color: '#888', marginRight: 8 }}>{excludedAlbums.length} Excluded</Text>
                        )}
                        <ChevronRight color="#888" size={20} />
                    </View>
                </TouchableOpacity>

                {Platform.OS === 'android' && (
                    <TouchableOpacity 
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8 }]}
                        onPress={() => {
                            Alert.alert(
                                "Battery Optimization",
                                "To ensure background backup runs reliably when your phone is asleep, please set Lomorage's battery usage to 'Unrestricted' in the system settings.",
                                [
                                    { text: "Cancel", style: "cancel" },
                                    { 
                                        text: "Open Settings", 
                                        onPress: () => {
                                            const { Linking } = require('react-native');
                                            Linking.openSettings().catch(() => {
                                                Alert.alert("Error", "Could not open system settings automatically.");
                                            });
                                        }
                                    }
                                ]
                            );
                        }}
                    >
                        <View style={styles.settingTextContainer}>
                            <Text style={styles.settingLabel}>Ignore Battery Optimizations</Text>
                            <Text style={styles.settingDescription}>
                                Recommended. Keeps background uploads running reliably when the device is asleep or locked.
                            </Text>
                        </View>
                        <ChevronRight color="#007AFF" size={20} />
                    </TouchableOpacity>
                )}

            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>AI & Search Settings</Text>

                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Local AI Features</Text>
                        <Text style={styles.settingDescription}>Enable on-device duplicate detection and semantic search. Uses offline machine learning models.</Text>
                    </View>
                    <Switch
                        value={aiEnabled}
                        onValueChange={toggleAIEnabled}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                {aiEnabled && (
                    <>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>AI Background Indexing Wi-Fi Only</Text>
                                <Text style={styles.settingDescription}>Only run background feature extraction (phash/embeddings) when connected to a Wi-Fi network.</Text>
                            </View>
                            <Switch
                                value={aiWifiOnly}
                                onValueChange={toggleAIWifiOnly}
                                trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                thumbColor={'#fff'}
                            />
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>AI Background Indexing Charging Only</Text>
                                <Text style={styles.settingDescription}>Only run background feature extraction when the device is plugged in and charging to prevent battery drain.</Text>
                            </View>
                            <Switch
                                value={aiChargingOnly}
                                onValueChange={toggleAIChargingOnly}
                                trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                thumbColor={'#fff'}
                            />
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Sync Remote AI Features</Text>
                                <Text style={styles.settingDescription}>Download and sync CLIP embeddings and photo fingerprints from the server for remote photos.</Text>
                            </View>
                            <Switch
                                value={remoteAIProcessingEnabled}
                                onValueChange={toggleRemoteAIProcessing}
                                trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                thumbColor={'#fff'}
                            />
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>AI Background Indexer Status</Text>
                                <Text style={styles.settingDescription}>{aiStatus.message}</Text>
                            </View>
                            {aiStatus.isProcessing && (
                                <ActivityIndicator size="small" color="#007AFF" style={{ marginLeft: 8 }} />
                            )}
                        </View>
                    </>
                )}
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Developer</Text>
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Asset Debug Mode</Text>
                        <Text style={styles.settingDescription}>Show cryptographic hashes and synchronization status directly on photos in the gallery and detail views.</Text>
                    </View>
                    <Switch
                        value={debugMode}
                        onValueChange={toggleDebugMode}
                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                        thumbColor={'#fff'}
                    />
                </View>

                {debugMode && (
                    <>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Search Match Strictness</Text>
                                <Text style={styles.settingDescription}>Adjust the similarity threshold. Higher values return fewer, more precise results.</Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <TouchableOpacity 
                                    onPress={() => updateSearchThreshold(Math.max(0.1, Math.round((searchThreshold - 0.02) * 100) / 100))}
                                    style={styles.stepperButton}
                                >
                                    <Text style={styles.stepperText}>-</Text>
                                </TouchableOpacity>
                                <Text style={styles.stepperValue}>{searchThreshold.toFixed(2)}</Text>
                                <TouchableOpacity 
                                    onPress={() => updateSearchThreshold(Math.min(0.5, Math.round((searchThreshold + 0.02) * 100) / 100))}
                                    style={styles.stepperButton}
                                >
                                    <Text style={styles.stepperText}>+</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Index Remote Photos Locally</Text>
                                <Text style={styles.settingDescription}>Download remote photos' previews and extract embeddings locally when charging and on Wi-Fi (for photos without server embeddings).</Text>
                            </View>
                            <Switch
                                value={remoteAIProcessingEnabled}
                                onValueChange={toggleRemoteAIProcessing}
                                trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                thumbColor={'#fff'}
                            />
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Hash Concurrency</Text>
                                <Text style={styles.settingDescription}>Parallel photo hashing. Higher is faster but uses more memory.</Text>
                            </View>
                            <View style={{flexDirection: 'row', alignItems: 'center'}}>
                                <TouchableOpacity onPress={() => updateHashConcurrency(Math.max(1, hashConcurrency - 1))} style={styles.stepperButton}>
                                    <Text style={styles.stepperText}>-</Text>
                                </TouchableOpacity>
                                <Text style={styles.stepperValue}>{hashConcurrency}</Text>
                                <TouchableOpacity onPress={() => updateHashConcurrency(Math.min(20, hashConcurrency + 1))} style={styles.stepperButton}>
                                    <Text style={styles.stepperText}>+</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Adaptive Concurrency</Text>
                                <Text style={styles.settingDescription}>Automatically use single-thread for large videos to prevent SD card thrashing, while keeping multi-thread for photos. Also auto-throttles on network errors.</Text>
                            </View>
                            <Switch
                                value={adaptiveConcurrencyEnabled}
                                onValueChange={toggleAdaptiveConcurrency}
                                trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                thumbColor={'#fff'}
                            />
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8, opacity: adaptiveConcurrencyEnabled ? 0.7 : 1 }]}>
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabel}>Upload Concurrency</Text>
                                <Text style={styles.settingDescription}>
                                    {adaptiveConcurrencyEnabled 
                                        ? 'Parallel uploads for photos (videos are auto-forced to 1).' 
                                        : 'Strict parallel uploads (warning: may crash RPi on videos).'}
                                </Text>
                            </View>
                            <View style={{flexDirection: 'row', alignItems: 'center'}}>
                                <TouchableOpacity onPress={() => updateUploadConcurrency(Math.max(1, uploadConcurrency - 1))} style={styles.stepperButton}>
                                    <Text style={styles.stepperText}>-</Text>
                                </TouchableOpacity>
                                <Text style={styles.stepperValue}>{uploadConcurrency}</Text>
                                <TouchableOpacity onPress={() => updateUploadConcurrency(Math.min(10, uploadConcurrency + 1))} style={styles.stepperButton}>
                                    <Text style={styles.stepperText}>+</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8, flexDirection: 'column', alignItems: 'stretch' }]}>
                            <View style={{ marginBottom: 10 }}>
                                <Text style={styles.settingLabel}>Clear Duplicates Cache (pHash)</Text>
                                <Text style={styles.settingDescription}>Instantly clear the duplicate photo cache. Re-indexing will run automatically in the background.</Text>
                            </View>
                            <TouchableOpacity
                                disabled={isPHashIndexing}
                                onPress={() => {
                                    Alert.alert(
                                        'Clear Duplicates Cache',
                                        'Are you sure you want to clear the duplicate detection cache? This will instantly empty the duplicates album. Re-indexing will run automatically in the background.',
                                        [
                                            { text: 'Cancel', style: 'cancel' },
                                            {
                                                text: 'Confirm',
                                                onPress: async () => {
                                                    setIsPHashIndexing(true);
                                                    try {
                                                        console.log('[SettingsScreen] Clearing duplicate pHashes cache...');
                                                        await AIService.forceRebuildPHash();
                                                        setIsPHashIndexing(false);
                                                        Alert.alert('Success', 'Duplicates cache cleared successfully! Recalculation is running in the background.');
                                                    } catch (err) {
                                                        setIsPHashIndexing(false);
                                                        Alert.alert('Error', 'Failed to clear cache: ' + err.message);
                                                    }
                                                }
                                            }
                                        ]
                                    );
                                }}
                                style={{ backgroundColor: isPHashIndexing ? '#999' : '#007AFF', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                            >
                                {isPHashIndexing ? (
                                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                                        <Text style={{ color: '#fff', fontWeight: 'bold' }}>Clearing cache...</Text>
                                    </View>
                                ) : (
                                    <Text style={{ color: '#fff', fontWeight: 'bold' }}>Clear Duplicates Cache</Text>
                                )}
                            </TouchableOpacity>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 12, paddingTop: 8, flexDirection: 'column', alignItems: 'stretch' }]}>
                            <View style={{ marginBottom: 10 }}>
                                <Text style={styles.settingLabel}>Clear Semantic Search Cache (CLIP)</Text>
                                <Text style={styles.settingDescription}>Instantly clear the semantic search cache. Re-indexing will run automatically in the background when the device is idle.</Text>
                            </View>
                            <TouchableOpacity
                                disabled={isCLIPIndexing}
                                onPress={() => {
                                    Alert.alert(
                                        'Clear Semantic Cache',
                                        'Are you sure you want to clear the semantic search cache? Re-indexing will run automatically in the background.',
                                        [
                                            { text: 'Cancel', style: 'cancel' },
                                            {
                                                text: 'Confirm',
                                                onPress: async () => {
                                                    setIsCLIPIndexing(true);
                                                    try {
                                                        console.log('[SettingsScreen] Clearing semantic search CLIP embeddings cache...');
                                                        await AIService.forceRebuildCLIP();
                                                        setIsCLIPIndexing(false);
                                                        Alert.alert('Success', 'Semantic search cache cleared successfully! Recalculation is running in the background.');
                                                    } catch (err) {
                                                        setIsCLIPIndexing(false);
                                                        Alert.alert('Error', 'Failed to clear cache: ' + err.message);
                                                    }
                                                }
                                            }
                                        ]
                                    );
                                }}
                                style={{ backgroundColor: isCLIPIndexing ? '#999' : '#007AFF', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                            >
                                {isCLIPIndexing ? (
                                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                                        <Text style={{ color: '#fff', fontWeight: 'bold' }}>Clearing cache...</Text>
                                    </View>
                                ) : (
                                    <Text style={{ color: '#fff', fontWeight: 'bold' }}>Clear Semantic Cache</Text>
                                )}
                            </TouchableOpacity>
                        </View>

                        <TouchableOpacity 
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}
                            onPress={() => {
                                Alert.alert(
                                    "Clear Hash Cache",
                                    "Wipes your local hashing history. Next scan will take much longer. Proceed?",
                                    [
                                        { text: "Cancel", style: "cancel" },
                                        { 
                                            text: "Clear", 
                                            style: "destructive",
                                            onPress: async () => {
                                                await SyncService.clearLocalHashCache();
                                                await loadStats();
                                                Alert.alert("Success", "Local hash cache cleared.");
                                            }
                                        }
                                    ]
                                );
                            }}
                        >
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabelDanger}>Local Hash Cache ({formatSize(stats.local)})</Text>
                                <Text style={styles.settingDescription}>Wipes the local file hashing history. Forces a full re-scan of all media.</Text>
                            </View>
                            <Trash2 color="#ef4444" size={20} />
                        </TouchableOpacity>

                        <TouchableOpacity 
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}
                            onPress={() => {
                                Alert.alert(
                                    "Clear Remote Cache",
                                    "Wipes the remote asset list cache. Will be refetched from server on next sync.",
                                    [
                                        { text: "Cancel", style: "cancel" },
                                        { 
                                            text: "Clear", 
                                            style: "destructive",
                                            onPress: async () => {
                                                await SyncService.clearRemoteTreeCache();
                                                await loadStats();
                                                Alert.alert("Success", "Remote tree cache cleared.");
                                            }
                                        }
                                    ]
                                );
                            }}
                        >
                            <View style={styles.settingTextContainer}>
                                <Text style={styles.settingLabelDanger}>Remote Asset Cache ({formatSize(stats.remote)})</Text>
                                <Text style={styles.settingDescription}>Wipes the cached remote Merkle tree. Forces a full fetch from server.</Text>
                            </View>
                            <Trash2 color="#ef4444" size={20} />
                        </TouchableOpacity>
                    </>
                )}

                <TouchableOpacity 
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8, paddingTop: 8 }]}
                    onPress={handleExportLogs}
                    disabled={isExportingLogs}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Send Logs</Text>
                        <Text style={styles.settingDescription}>
                            {isExportingLogs ? 'Packaging logs...' : 'Export local and server logs as a zip file.'}
                        </Text>
                    </View>
                    {isExportingLogs 
                        ? <ActivityIndicator size="small" color="#007AFF" /> 
                        : <Send color="#007AFF" size={20} />
                    }
                </TouchableOpacity>
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Server Connection</Text>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={styles.settingLabel}>Current Server</Text>
                            {isReachable === null ? (
                                <ActivityIndicator size="small" color="#007AFF" style={{ marginLeft: 8 }} />
                            ) : (
                                <>
                                    <View style={[
                                        styles.statusDot, 
                                        { backgroundColor: isReachable ? '#10B981' : '#EF4444' }
                                    ]} />
                                    <Text style={[
                                        styles.statusText, 
                                        { color: isReachable ? '#10B981' : '#EF4444' }
                                    ]}>
                                        {isReachable ? 'Online' : 'Offline'}
                                    </Text>
                                </>
                            )}
                        </View>
                        <Text style={styles.settingDescription}>{serverUrl || 'Not configured'}</Text>
                        {serverName && <Text style={styles.serverBadge}>Identity: {serverName}</Text>}
                        {localUrl && <Text style={{fontSize: 12, color: '#666', marginTop: 8}}>• Local: {localUrl}</Text>}
                        {remoteUrl && <Text style={{fontSize: 12, color: '#666', marginTop: 2}}>• Remote: {remoteUrl}</Text>}
                    </View>
                    <Server color="#4A5568" size={24} />
                </View>

                <TouchableOpacity 
                    style={styles.settingRow}
                    onPress={handleReProbe}
                    disabled={isScanning}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Re-scan Network</Text>
                        <Text style={styles.settingDescription}>
                            {isScanning ? 'Scanning for servers...' : 'Search for your Lomorage server via mDNS.'}
                        </Text>
                    </View>
                    {isScanning
                        ? <ActivityIndicator size="small" color="#007AFF" />
                        : <RefreshCcw color="#007AFF" size={20} />
                    }
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.settingRow, { marginTop: 10 }]}
                    onPress={() => {
                        setTempRemoteUrl(remoteUrl || '');
                        setRemoteModalVisible(true);
                    }}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Set Remote Address</Text>
                        <Text style={styles.settingDescription}>Configure your domain for remote access.</Text>
                    </View>
                    <Globe color="#007AFF" size={20} />
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.settingRow, { marginTop: 10 }]}
                    onPress={() => navigation.navigate('Register', { fromSettings: true })}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Create New Account</Text>
                        <Text style={styles.settingDescription}>Register a new user on this Lomorage server.</Text>
                    </View>
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.settingRow, { marginTop: 10 }]}
                    onPress={() => {
                        Alert.alert(
                            "Log Out",
                            "Are you sure you want to log out of your account?",
                            [
                                { text: "Cancel", style: "cancel" },
                                { 
                                    text: "Log Out", 
                                    style: "destructive",
                                    onPress: async () => {
                                        await logout();
                                    }
                                }
                            ]
                        );
                    }}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabelDanger}>Log Out</Text>
                        <Text style={styles.settingDescription}>Disconnect from this server and return to the login screen.</Text>
                    </View>
                </TouchableOpacity>
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>About</Text>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Client Version</Text>
                        <Text style={styles.settingDescription}>{clientVersion}</Text>
                    </View>
                </View>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Server Version</Text>
                        <Text style={styles.settingDescription}>{serverVersion}</Text>
                    </View>
                </View>
            </View>
            </ScrollView>

            <Modal
                visible={isRemoteModalVisible}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setRemoteModalVisible(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Remote Address</Text>
                        <Text style={styles.modalDescription}>
                            Enter your public domain or remote IP address.
                        </Text>
                        <TextInput
                            style={styles.modalInput}
                            value={tempRemoteUrl}
                            onChangeText={setTempRemoteUrl}
                            placeholder="https://lomo.your-domain.com"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <View style={styles.modalButtons}>
                            <TouchableOpacity 
                                style={[styles.modalButton, styles.modalButtonCancel]} 
                                onPress={() => setRemoteModalVisible(false)}
                            >
                                <Text style={styles.modalButtonTextCancel}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity 
                                style={[styles.modalButton, styles.modalButtonSave]} 
                                onPress={handleSaveRemoteUrl}
                            >
                                <Text style={styles.modalButtonTextSave}>Save</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Album Selection Modal */}
            <Modal
                visible={isAlbumModalVisible}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setAlbumModalVisible(false)}
            >
                <View style={styles.albumModalContainer}>
                    <View style={styles.albumModalHeader}>
                        <Text style={styles.albumModalTitle}>Selective Backup</Text>
                        <TouchableOpacity onPress={() => setAlbumModalVisible(false)} style={styles.albumCloseButton}>
                            <X color="#333" size={24} />
                        </TouchableOpacity>
                    </View>
                    
                    <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
                        <Text style={styles.settingDescription}>
                            Turn off the switch to IGNORE an album. Only assets in ON albums will be backed up.
                        </Text>
                    </View>

                    <FlatList
                        data={albumsList}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={{ paddingBottom: 40 }}
                        renderItem={({ item }) => {
                            const isExcluded = excludedAlbums.includes(item.id);
                            const isIncluded = !isExcluded;
                            return (
                                <TouchableOpacity 
                                    style={styles.albumRow}
                                    onPress={() => handlePreviewAlbum(item)}
                                >
                                    <View style={styles.albumInfo}>
                                        <Folder color="#007AFF" size={24} style={{ marginRight: 12 }} />
                                        <View>
                                            <Text style={styles.albumTitle}>{item.title}</Text>
                                            <Text style={styles.albumCount}>{item.assetCount} items</Text>
                                        </View>
                                    </View>
                                    <Switch
                                        value={isIncluded}
                                        onValueChange={() => toggleAlbumExclusion(item.id)}
                                        trackColor={{ false: '#d1d1d1', true: '#4CAF50' }}
                                        thumbColor={'#fff'}
                                    />
                                </TouchableOpacity>
                            );
                        }}
                        ListEmptyComponent={
                            <View style={{ padding: 20, alignItems: 'center' }}>
                                <Text style={{ color: '#888' }}>No albums found.</Text>
                            </View>
                        }
                    />
                </View>
            </Modal>

            {/* Album Preview Modal */}
            <Modal
                visible={isAlbumPreviewModalVisible}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setAlbumPreviewModalVisible(false)}
            >
                <View style={styles.albumModalContainer}>
                    <View style={styles.albumModalHeader}>
                        <Text style={styles.albumModalTitle}>{previewAlbum?.title}</Text>
                        <TouchableOpacity onPress={() => setAlbumPreviewModalVisible(false)} style={styles.albumCloseButton}>
                            <X color="#333" size={24} />
                        </TouchableOpacity>
                    </View>
                    
                    {previewLoading ? (
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator size="large" color="#007AFF" />
                        </View>
                    ) : (
                        <FlatList
                            data={previewAssets}
                            keyExtractor={(item) => item.id}
                            numColumns={3}
                            onEndReached={loadMorePreviewAssets}
                            onEndReachedThreshold={0.5}
                            renderItem={({ item, index }) => {
                                const size = Dimensions.get('window').width / 3;
                                return (
                                    <TouchableOpacity 
                                        style={{ width: size, height: size, borderWidth: 1, borderColor: '#fff', position: 'relative' }}
                                        onPress={() => setSelectedAssetIndexToView(index)}
                                    >
                                        <Image 
                                            source={{ uri: item.uri }} 
                                            style={{ flex: 1 }} 
                                            cachePolicy="memory-disk"
                                            contentFit="cover"
                                        />
                                        {item.mediaType === 'video' && (
                                            <View style={{ ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                                                <PlayCircle color="#fff" size={32} />
                                            </View>
                                        )}
                                    </TouchableOpacity>
                                );
                            }}
                            ListFooterComponent={
                                previewLoadingMore ? (
                                    <View style={{ padding: 20, alignItems: 'center' }}>
                                        <ActivityIndicator size="small" color="#007AFF" />
                                    </View>
                                ) : null
                            }
                            ListEmptyComponent={
                                <View style={{ padding: 20, alignItems: 'center' }}>
                                    <Text style={{ color: '#888' }}>No photos found in this folder.</Text>
                                </View>
                            }
                        />
                    )}
                </View>
            </Modal>

            {/* Full Screen Asset Viewer Modal */}
            <Modal
                visible={selectedAssetIndexToView !== null}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setSelectedAssetIndexToView(null)}
            >
                {selectedAssetIndexToView !== null && (
                    <View style={{ flex: 1, backgroundColor: '#000' }}>
                        <TouchableOpacity 
                            style={{ position: 'absolute', top: Platform.OS === 'ios' ? 65 : 45, right: 20, zIndex: 10, padding: 15, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 30 }}
                            onPress={() => setSelectedAssetIndexToView(null)}
                            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                        >
                            <X color="#fff" size={28} />
                        </TouchableOpacity>
                        
                        <FlatList
                            data={previewAssets}
                            horizontal
                            pagingEnabled
                            keyExtractor={(item) => item.id}
                            initialScrollIndex={selectedAssetIndexToView}
                            getItemLayout={(data, index) => ({
                                length: Dimensions.get('window').width,
                                offset: Dimensions.get('window').width * index,
                                index,
                            })}
                            onViewableItemsChanged={onViewableItemsChanged}
                            viewabilityConfig={viewabilityConfig}
                            renderItem={({ item, index }) => (
                                <View style={{ width: Dimensions.get('window').width, flex: 1 }}>
                                    {/* Always mount the image so there is no flash when switching to/from video player */}
                                    <Image 
                                        source={{ uri: item.uri }} 
                                        style={{ flex: 1 }} 
                                        contentFit="contain"
                                    />
                                    {/* Conditionally overlay the video player when active */}
                                    {item.mediaType === 'video' && selectedAssetIndexToView === index && (
                                        <View style={StyleSheet.absoluteFillObject}>
                                            <SimpleVideoPlayer uri={item.uri} isActive={true} />
                                        </View>
                                    )}
                                </View>
                            )}
                            onEndReached={loadMorePreviewAssets}
                            onEndReachedThreshold={0.5}
                        />
                    </View>
                )}
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f5f5f5',
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
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1a1a1a',
    },
    section: {
        marginTop: 20,
        backgroundColor: '#fff',
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: '#eee',
        paddingVertical: 10,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: '#64748B',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
        marginLeft: 16,
    },
    settingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    settingTextContainer: {
        flex: 1,
        marginRight: 20,
    },
    settingLabel: {
        fontSize: 16,
        color: '#333',
        fontWeight: '500',
    },
    settingLabelDanger: {
        fontSize: 16,
        color: '#ef4444',
        fontWeight: '500',
    },
    settingDescription: {
        fontSize: 13,
        color: '#888',
        marginTop: 4,
        lineHeight: 18,
    },
    serverBadge: {
        fontSize: 12,
        color: '#007AFF',
        backgroundColor: '#EBF4FF',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        marginTop: 4,
        alignSelf: 'flex-start',
        fontWeight: '600',
    },
    rotating: {
        // Animation is better handled via Animated API, but for simplicity
        // in a web-like dev experience we can just dim it or let the system handle it
        opacity: 0.5,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginLeft: 8,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '600',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    modalContent: {
        backgroundColor: '#FFF',
        borderRadius: 16,
        padding: 24,
        width: '100%',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
        elevation: 4,
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#1A202C',
        marginBottom: 8,
    },
    modalDescription: {
        fontSize: 14,
        color: '#718096',
        marginBottom: 20,
    },
    modalInput: {
        borderWidth: 1,
        borderColor: '#E2E8F0',
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        color: '#2D3748',
        backgroundColor: '#F8FAFC',
        marginBottom: 24,
    },
    modalButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
    },
    modalButton: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalButtonCancel: {
        backgroundColor: '#EDF2F7',
    },
    modalButtonSave: {
        backgroundColor: '#007AFF',
    },
    modalButtonTextCancel: {
        color: '#4A5568',
        fontSize: 15,
        fontWeight: '600',
    },
    urlButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600'
    },
    albumRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0'
    },
    albumInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    albumTitle: {
        fontSize: 16,
        color: '#333',
        fontWeight: '500'
    },
    albumCount: {
        fontSize: 13,
        color: '#888',
        marginTop: 2
    },
    modalButtonTextSave: {
        color: '#FFF',
        fontSize: 15,
        fontWeight: 'bold',
    },
    albumModalContainer: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        paddingTop: Platform.OS === 'ios' ? 10 : 40, // iOS pageSheet already handles safe area mostly, but Android needs it
    },
    albumModalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 15,
        backgroundColor: '#f8f9fa',
        borderBottomWidth: 1,
        borderBottomColor: '#ebebeb',
    },
    albumModalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#1c1c1e',
    },
    albumCloseButton: {
        padding: 5,
    },
    stepperButton: {
        borderWidth: 1,
        borderColor: '#E2E8F0',
        borderRadius: 6,
        width: 32,
        height: 32,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#FFF'
    },
    stepperText: {
        fontSize: 18,
        color: '#4A5568',
        fontWeight: 'bold',
        marginTop: -2,
    },
    stepperValue: {
        fontSize: 16,
        fontWeight: '600',
        color: '#1A202C',
        marginHorizontal: 12,
        minWidth: 20,
        textAlign: 'center'
    }
});
