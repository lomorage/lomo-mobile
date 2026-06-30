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
    const [remoteAIProcessingEnabled, setRemoteAIProcessingEnabled] = useState(true);
    const [searchThreshold, setSearchThreshold] = useState(0.25);
    const [aiWifiOnly, setAIWifiOnly] = useState(true);
    const [aiChargingOnly, setAIChargingOnly] = useState(true);
    const [aiEnabled, setAiEnabled] = useState(true);
    const [iosBackgroundKeepAlive, setIosBackgroundKeepAlive] = useState(false);
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
            const savedRemoteAI = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
            if (savedRemoteAI !== null) {
                setRemoteAIProcessingEnabled(savedRemoteAI === 'true');
            } else {
                setRemoteAIProcessingEnabled(true);
            }
            const savedThreshold = await SecureStore.getItemAsync('lomorage_search_threshold');
            if (savedThreshold !== null) {
                setSearchThreshold(parseFloat(savedThreshold));
            }
            const savedAIWifi = await SecureStore.getItemAsync('lomorage_ai_wifi_only');
            if (savedAIWifi !== null) {
                setAIWifiOnly(savedAIWifi === 'true');
            }
            const savedAICharging = await SecureStore.getItemAsync('lomorage_ai_charging_only');
            if (savedAICharging !== null) {
                setAIChargingOnly(savedAICharging === 'true');
            }
            const savedAIEnabled = await SecureStore.getItemAsync('lomorage_ai_enabled');
            if (savedAIEnabled !== null) {
                setAiEnabled(savedAIEnabled === 'true');
            }
            const savedIosKeepAlive = await SecureStore.getItemAsync('lomorage_ios_keep_alive');
            if (savedIosKeepAlive !== null) {
                setIosBackgroundKeepAlive(savedIosKeepAlive === 'true');
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

    const toggleRemoteAIProcessing = async () => {
        try {
            const newValue = !remoteAIProcessingEnabled;
            await SecureStore.setItemAsync('lomorage_remote_ai_processing', newValue.toString());
            setRemoteAIProcessingEnabled(newValue);
            const AIService = require('../services/AIService').default;
            if (newValue && aiEnabled) {
                // Immediately start syncing remote embeddings
                AIService.syncEmbeddings(true).catch(e => console.warn('[SettingsContext] Remote AI sync failed:', e.message));
                AIService.registerBackgroundSync();
            } else {
                AIService.unregisterBackgroundSync();
            }
        } catch (error) {
            console.error('Failed to update remote AI processing setting', error);
        }
    };

    const toggleAIWifiOnly = async () => {
        try {
            const newValue = !aiWifiOnly;
            await SecureStore.setItemAsync('lomorage_ai_wifi_only', newValue.toString());
            setAIWifiOnly(newValue);
            if (aiEnabled) {
                const AIService = require('../services/AIService').default;
                (async () => {
                    await AIService.processLocalEmbeddings(30);
                    await AIService.syncEmbeddings();
                })().catch(e => console.warn('[SettingsContext] AI sync failed:', e.message));
            }
        } catch (error) {
            console.error('Failed to update AI Wi-Fi only setting', error);
        }
    };

    const toggleAIChargingOnly = async () => {
        try {
            const newValue = !aiChargingOnly;
            await SecureStore.setItemAsync('lomorage_ai_charging_only', newValue.toString());
            setAIChargingOnly(newValue);
            if (aiEnabled) {
                const AIService = require('../services/AIService').default;
                (async () => {
                    await AIService.processLocalEmbeddings(30);
                    await AIService.syncEmbeddings();
                })().catch(e => console.warn('[SettingsContext] AI sync failed:', e.message));
            }
        } catch (error) {
            console.error('Failed to update AI charging only setting', error);
        }
    };

    const toggleAIEnabled = async () => {
        try {
            const newValue = !aiEnabled;
            await SecureStore.setItemAsync('lomorage_ai_enabled', newValue.toString());
            setAiEnabled(newValue);
            const AIService = require('../services/AIService').default;
            if (newValue) {
                (async () => {
                    await AIService.processLocalEmbeddings(30);
                    await AIService.syncEmbeddings();
                })().catch(e => console.warn('[SettingsContext] AI sync failed:', e.message));
                if (remoteAIProcessingEnabled) {
                    AIService.registerBackgroundSync();
                }
            } else {
                AIService.unregisterBackgroundSync();
            }
        } catch (error) {
            console.error('Failed to update AI enabled setting', error);
        }
    };

    const toggleIosBackgroundKeepAlive = async () => {
        try {
            const newValue = !iosBackgroundKeepAlive;
            await SecureStore.setItemAsync('lomorage_ios_keep_alive', newValue.toString());
            setIosBackgroundKeepAlive(newValue);
            import('react-native').then(({ DeviceEventEmitter }) => {
                DeviceEventEmitter.emit('settingsChanged', { 
                    iosBackgroundKeepAlive: newValue 
                });
            });
        } catch (error) {
            console.error('Failed to update iOS background keep-alive setting', error);
        }
    };

    const updateSearchThreshold = async (val) => {
        try {
            await SecureStore.setItemAsync('lomorage_search_threshold', val.toString());
            setSearchThreshold(val);
        } catch (error) {
            console.error('Failed to save search threshold', error);
        }
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
            remoteAIProcessingEnabled,
            toggleRemoteAIProcessing,
            searchThreshold,
            updateSearchThreshold,
            aiWifiOnly,
            toggleAIWifiOnly,
            aiChargingOnly,
            toggleAIChargingOnly,
            aiEnabled,
            toggleAIEnabled,
            iosBackgroundKeepAlive,
            toggleIosBackgroundKeepAlive,
            isLoading
        }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
