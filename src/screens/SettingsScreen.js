import React from 'react';
import { StyleSheet, View, Text, Switch, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { ChevronLeft, Trash2, RefreshCcw, Server } from 'lucide-react-native';
import { useSettings } from '../context/SettingsContext';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';

export default function SettingsScreen({ navigation }) {
    const { debugMode, toggleDebugMode, autoBackupEnabled, toggleAutoBackup, wifiOnlyBackup, toggleWifiOnly } = useSettings();
    const [stats, setStats] = React.useState({ local: 0, remote: 0 });
    const [isScanning, setIsScanning] = React.useState(false);
    const [serverUrl, setServerUrl] = React.useState(AuthService.getServerUrl());
    const [serverName, setServerName] = React.useState(AuthService.getServerName());

    React.useEffect(() => {
        loadStats();
    }, []);

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
        try {
            const success = await AuthService.autoProbe();
            if (success) {
                const newUrl = AuthService.getServerUrl();
                setServerUrl(newUrl);
                setServerName(AuthService.getServerName());
                Alert.alert("Server Found ✓", `Connected to:\n${newUrl}`);
            } else {
                Alert.alert(
                    "Server Not Found",
                    "No Lomorage server was found on your local network.\n\nMake sure:\n• Your server is running\n• Your phone is on the same Wi-Fi"
                );
            }
        } catch (e) {
            Alert.alert("Scan Error", "An unexpected error occurred during discovery.");
        } finally {
            setIsScanning(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
                    <ChevronLeft color="#000" size={28} />
                </TouchableOpacity>
                <Text style={styles.title}>Settings</Text>
                <View style={{ width: 44 }} />
            </View>

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

                <TouchableOpacity 
                    style={styles.settingRow}
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
                    style={styles.settingRow}
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
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Server Connection</Text>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Current Server</Text>
                        <Text style={styles.settingDescription}>{serverUrl || 'Not configured'}</Text>
                        {serverName && <Text style={styles.serverBadge}>Identity: {serverName}</Text>}
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
            </View>
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
        color: '#666',
        textTransform: 'uppercase',
        marginLeft: 20,
        marginBottom: 10,
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
    }
});
