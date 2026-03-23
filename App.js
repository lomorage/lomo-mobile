import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import RootNavigator from './src/navigation/RootNavigator';
import { BACKGROUND_BACKUP_TASK } from './src/services/AutoBackupManager';

export default function App() {
  useEffect(() => {
    const registerTask = async () => {
      try {
        const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_BACKUP_TASK);
        if (!isRegistered) {
          console.log('[App] Registering background backup task...');
          await BackgroundTask.registerTaskAsync(BACKGROUND_BACKUP_TASK, {
            minimumInterval: 15 * 60, // 15 minutes
            stopOnTerminate: false,    // Continue after app is killed
            startOnBoot: true,        // Continue after device reboot
          });
        }
      } catch (err) {
        console.error('[App] Background task registration failed:', err);
      }
    };
    registerTask();
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <RootNavigator />
    </>
  );
}

