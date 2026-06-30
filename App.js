import 'react-native-gesture-handler';
import Logger from './src/utils/logger';
Logger.init();
import React, { useEffect } from 'react';
import { View, DeviceEventEmitter } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import RootNavigator from './src/navigation/RootNavigator';
import AutoBackupManager from './src/services/AutoBackupManager';
import AssetDBService from './src/services/AssetDBService';
import AIService from './src/services/AIService';
import * as SecureStore from 'expo-secure-store';

export default function App() {
  useEffect(() => {
    const initApp = async () => {
      try {
        await AssetDBService.init();
        
        // Start background prewarming of AI vector cache
        AIService.prewarmVectorCache();
        const remoteAIEnabled = await SecureStore.getItemAsync('lomorage_remote_ai_processing');
        if (remoteAIEnabled !== 'false') {
          AIService.registerBackgroundSync();
        }
      } catch (err) {
        console.error('[App] Failed to init App services:', err);
      }
    };
    initApp();
  }, []);

  return (
    <View 
      style={{ flex: 1 }} 
      onStartShouldSetResponderCapture={() => {
        DeviceEventEmitter.emit('user_interaction');
        return false;
      }}
    >
      <StatusBar style="auto" />
      <RootNavigator />
    </View>
  );
}

