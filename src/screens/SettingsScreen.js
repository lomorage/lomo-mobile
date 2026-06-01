import React from 'react';
import { StyleSheet, View, ScrollView, Text, Switch, TouchableOpacity, Alert, ActivityIndicator, Platform } from 'react-native';
import { ChevronLeft, Trash2, RefreshCcw, Server, ChevronRight } from 'lucide-react-native';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';

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
        toggleNightBackup 
    } = useSettings();
    const { logout } = useAuth();
    const [stats, setStats] = React.useState({ local: 0, remote: 0 });
    const [isScanning, setIsScanning] = React.useState(false);
    const [serverUrl, setServerUrl] = React.useState(AuthService.getServerUrl());
    const [serverName, setServerName] = React.useState(AuthService.getServerName());

    const [isReachable, setIsReachable] = React.useState(null);

    React.useEffect(() => {
        loadStats();
        checkServerReachability();
    }, [serverUrl]);

    const checkServerReachability = async () => {
        if (!serverUrl) {
            setIsReachable(false);
            return;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${serverUrl}/`, {
                method: 'GET',
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            setIsReachable(response.status === 200 || response.status < 500);
        } catch (e) {
            setIsReachable(false);
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
            </ScrollView>
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
    }
});
