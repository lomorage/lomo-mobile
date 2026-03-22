import React, { createContext, useState, useContext, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';

const SettingsContext = createContext({});

export function SettingsProvider({ children }) {
    const [debugMode, setDebugMode] = useState(false);
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

    return (
        <SettingsContext.Provider value={{ debugMode, toggleDebugMode, isLoading }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
