import React from 'react';
import { StyleSheet, View, Text, Switch, TouchableOpacity, Alert } from 'react-native';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { useSettings } from '../context/SettingsContext';
import SyncService from '../services/SyncService';

export default function SettingsScreen({ navigation }) {
    const { debugMode, toggleDebugMode } = useSettings();

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
                    <ChevronLeft color="#000" size={28} />
                </TouchableOpacity>
                <Text style={styles.title}>Settings</Text>
                <View style={{ width: 44 }} /> {/* Spacer to center title */}
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Developer</Text>
                
                <View style={styles.settingRow}>
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Asset Debug Mode</Text>
                        <Text style={styles.settingDescription}>
                            Show cryptographic hashes and synchronization status directly on photos in the gallery and detail views.
                        </Text>
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
                            "Clear Cache",
                            "Are you sure you want to clear the local hash cache? This will force a full rescan.",
                            [
                                { text: "Cancel", style: "cancel" },
                                { 
                                    text: "Clear", 
                                    style: "destructive",
                                    onPress: async () => {
                                        await SyncService.clearCache();
                                        Alert.alert("Success", "Cache cleared. Please pull down to refresh the gallery.");
                                    }
                                }
                            ]
                        );
                    }}
                >
                    <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabelDanger}>Clear Local Hash Cache</Text>
                        <Text style={styles.settingDescription}>
                            Wipes the SQLite and file hashing cache. Next sync will take significantly longer.
                        </Text>
                    </View>
                    <Trash2 color="#ef4444" size={20} />
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
    }
});
