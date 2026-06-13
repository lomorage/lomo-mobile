import React, { createContext, useState, useContext, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';

const SettingsContext = createContext({});

export function SettingsProvider({ children }) {
    const [debugMode, setDebugMode] = useState(false);
    const [autoBackupEnabled, setAutoBackupEnabled] = useState(true);
    const [wifiOnlyBackup, setWifiOnlyBackup] = useState(true);
    const [chargingOnlyBackup, setChargingOnlyBackup] = useState(false);
    const [nightBackupOnly, setNightBackupOnly] = useState(false);
    const [adaptiveConcurrencyEnabled, setAdaptiveConcurrencyEnabled] = useState(true);
    const [hashConcurrency, setHashConcurrency] = useState(2);
    const [uploadConcurrency, setUploadConcurrency] = useState(3);
    const [excludedAlbums, setExcludedAlbums] = useState([]);
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
            const savedChargingOnly = await SecureStore.getItemAsync('lomorage_charging_only');
            if (savedChargingOnly !== null) {
                setChargingOnlyBackup(savedChargingOnly === 'true');
            }
            const savedNightBackup = await SecureStore.getItemAsync('lomorage_night_backup');
            if (savedNightBackup !== null) {
                setNightBackupOnly(savedNightBackup === 'true');
            }
            const savedAdaptive = await SecureStore.getItemAsync('lomorage_adaptive_concurrency');
            if (savedAdaptive !== null) {
                setAdaptiveConcurrencyEnabled(savedAdaptive === 'true');
            }
            const savedHashConcurrency = await SecureStore.getItemAsync('lomorage_hash_concurrency');
            if (savedHashConcurrency !== null) {
                setHashConcurrency(parseInt(savedHashConcurrency, 10));
            }
            const savedUploadConcurrency = await SecureStore.getItemAsync('lomorage_upload_concurrency');
            if (savedUploadConcurrency !== null) {
                setUploadConcurrency(parseInt(savedUploadConcurrency, 10));
            }
            const savedExcludedAlbums = await SecureStore.getItemAsync('lomorage_excluded_albums');
            if (savedExcludedAlbums !== null) {
                try {
                    setExcludedAlbums(JSON.parse(savedExcludedAlbums));
                } catch (e) {
                    console.error('Failed to parse excluded albums:', e);
                }
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
                DeviceEventEmitter.emit('settingsChanged', { 
                    autoBackupEnabled: newValue, 
                    wifiOnlyBackup, 
                    chargingOnlyBackup, 
                    nightBackupOnly 
                });
            });
        } catch (error) {}
    };

    const toggleWifiOnly = async () => {
        try {
            const newValue = !wifiOnlyBackup;
            await SecureStore.setItemAsync('lomorage_wifi_only', newValue.toString());
            setWifiOnlyBackup(newValue);
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { 
                    autoBackupEnabled, 
                    wifiOnlyBackup: newValue, 
                    chargingOnlyBackup, 
                    nightBackupOnly 
                });
            });
        } catch (error) {}
    };

    const toggleChargingOnly = async () => {
        try {
            const newValue = !chargingOnlyBackup;
            await SecureStore.setItemAsync('lomorage_charging_only', newValue.toString());
            setChargingOnlyBackup(newValue);
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { 
                    autoBackupEnabled, 
                    wifiOnlyBackup, 
                    chargingOnlyBackup: newValue, 
                    nightBackupOnly 
                });
            });
        } catch (error) {}
    };

    const toggleNightBackup = async () => {
        try {
            const newValue = !nightBackupOnly;
            await SecureStore.setItemAsync('lomorage_night_backup', newValue.toString());
            setNightBackupOnly(newValue);
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { 
                    autoBackupEnabled, 
                    wifiOnlyBackup, 
                    chargingOnlyBackup, 
                    nightBackupOnly: newValue 
                });
            });
        } catch (error) {}
    };

    const toggleNightBackupOnly = async () => {
        try {
            const newValue = !nightBackupOnly;
            await SecureStore.setItemAsync('lomorage_night_backup', newValue.toString());
            setNightBackupOnly(newValue);
        } catch (error) {
            console.error('Failed to update night backup only setting', error);
        }
    };

    const toggleAdaptiveConcurrency = async () => {
        try {
            const newValue = !adaptiveConcurrencyEnabled;
            await SecureStore.setItemAsync('lomorage_adaptive_concurrency', newValue.toString());
            setAdaptiveConcurrencyEnabled(newValue);
        } catch (error) {
            console.error('Failed to update adaptive concurrency setting', error);
        }
    };

    const updateHashConcurrency = async (val) => {
        try {
            await SecureStore.setItemAsync('lomorage_hash_concurrency', val.toString());
            setHashConcurrency(val);
        } catch (error) {}
    };

    const updateUploadConcurrency = async (value) => {
        setUploadConcurrency(value);
        await SecureStore.setItemAsync('lomorage_upload_concurrency', value.toString());
    };

    const toggleAlbumExclusion = async (albumId) => {
        let newList;
        if (excludedAlbums.includes(albumId)) {
            newList = excludedAlbums.filter(id => id !== albumId);
        } else {
            newList = [...excludedAlbums, albumId];
        }
        setExcludedAlbums(newList);
        await SecureStore.setItemAsync('lomorage_excluded_albums', JSON.stringify(newList));
    };

    return (
        <SettingsContext.Provider value={{
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
            toggleNightBackupOnly,
            adaptiveConcurrencyEnabled,
            toggleAdaptiveConcurrency,
            hashConcurrency,
            updateHashConcurrency,
            uploadConcurrency,
            updateUploadConcurrency,
            excludedAlbums,
            toggleAlbumExclusion,
            isLoading
        }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
