import { AppState, Platform, DeviceEventEmitter } from 'react-native';
import * as Battery from 'expo-battery';

class TaskSchedulerService {
    constructor() {
        this.lastInteractionTime = 0;
        this.INTERACTION_TIMEOUT = 3000; // 3 seconds after last touch to be considered "idle"
        this.appState = AppState.currentState;

        AppState.addEventListener('change', nextAppState => {
            this.appState = nextAppState;
        });

        // Listen for interaction events
        DeviceEventEmitter.addListener('user_interaction', () => {
            this.lastInteractionTime = Date.now();
        });
    }

    // Is the user actively using the app (touching the screen)?
    isInteractive() {
        if (this.appState !== 'active') return false;
        return Date.now() - this.lastInteractionTime < this.INTERACTION_TIMEOUT;
    }

    // Resolves when the app is no longer interactive (or immediately if already idle)
    async waitUntilIdle() {
        while (this.isInteractive()) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // Is battery sufficient for heavy background tasks (AI / big uploads)?
    async hasSufficientBattery() {
        try {
            const batteryLevel = await Battery.getBatteryLevelAsync();
            const batteryState = await Battery.getBatteryStateAsync();
            const isCharging = batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL;
            // Battery > 20% or plugged in
            return batteryLevel > 0.2 || isCharging;
        } catch (e) {
            return true; // Assume true if we can't read it
        }
    }
}

export default new TaskSchedulerService();
