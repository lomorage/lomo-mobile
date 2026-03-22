import React, { createContext, useState, useContext, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';

const SettingsContext = createContext({});

export function SettingsProvider({ children }) {
    const [debugMode, setDebugMode] = useState(false);
    const [autoBackupEnabled, setAutoBackupEnabled] = useState(true);
    const [wifiOnlyBackup, setWifiOnlyBackup] = useState(true);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const savedDebugMode = await SecureStore.getItemAsync('lomorage_debug_mode');
            if (savedDebugMode !== null) {
                setDebugMode(savedDebugMode === 'true');
            }
            const savedAutoBackup = await SecureStore.getItemAsync('lomorage_auto_backup');
            if (savedAutoBackup !== null) {
                setAutoBackupEnabled(savedAutoBackup === 'true');
            }
            const savedWifiOnly = await SecureStore.getItemAsync('lomorage_wifi_only');
            if (savedWifiOnly !== null) {
                setWifiOnlyBackup(savedWifiOnly === 'true');
            }
        } catch (error) {
            console.error('Failed to load settings', error);
        } finally {
            setIsLoading(false);
        }
    };

    const toggleDebugMode = async () => {
        try {
            const newValue = !debugMode;
            await SecureStore.setItemAsync('lomorage_debug_mode', newValue.toString());
            setDebugMode(newValue);
        } catch (error) {
            console.error('Failed to save settings', error);
        }
    };

    const toggleAutoBackup = async () => {
        try {
            const newValue = !autoBackupEnabled;
            await SecureStore.setItemAsync('lomorage_auto_backup', newValue.toString());
            setAutoBackupEnabled(newValue);
            // Notify background manager immediately
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { autoBackupEnabled: newValue, wifiOnlyBackup });
            });
        } catch (error) {}
    };

    const toggleWifiOnly = async () => {
        try {
            const newValue = !wifiOnlyBackup;
            await SecureStore.setItemAsync('lomorage_wifi_only', newValue.toString());
            setWifiOnlyBackup(newValue);
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { autoBackupEnabled, wifiOnlyBackup: newValue });
            });
        } catch (error) {}
    };

    return (
        <SettingsContext.Provider value={{ debugMode, toggleDebugMode, autoBackupEnabled, toggleAutoBackup, wifiOnlyBackup, toggleWifiOnly, isLoading }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
