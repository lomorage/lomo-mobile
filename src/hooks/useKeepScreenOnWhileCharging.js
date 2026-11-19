import { useEffect, useState } from 'react';
import * as Battery from 'expo-battery';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// Its own tag, so it never releases the first-backup keep-awake (HomeScreen)
// or is released by it.
export const KEEP_SCREEN_ON_TAG = 'lomorage-keep-screen-on-charging';

export function isChargingState(state) {
    return state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
}

// Keeps the screen on while `enabled` and the phone is charging. Android and
// iOS slow down or stop backup and photo analysis once the screen sleeps,
// even with battery optimisation off. The keep-awake flag only holds while
// the app is in the foreground, so leaving Lomorage lets the screen sleep.
export default function useKeepScreenOnWhileCharging(enabled) {
    const [charging, setCharging] = useState(false);

    useEffect(() => {
        if (!enabled) {
            setCharging(false);
            return undefined;
        }
        let live = true;
        Battery.getBatteryStateAsync()
            .then((state) => { if (live) setCharging(isChargingState(state)); })
            .catch(() => {});
        const subscription = Battery.addBatteryStateListener(({ batteryState }) => {
            if (live) setCharging(isChargingState(batteryState));
        });
        return () => {
            live = false;
            subscription?.remove?.();
        };
    }, [enabled]);

    const keepOn = enabled && charging;
    useEffect(() => {
        if (!keepOn) return undefined;
        activateKeepAwakeAsync(KEEP_SCREEN_ON_TAG).catch((e) => {
            console.warn('[KeepScreenOn] Could not keep the screen on:', e?.message);
        });
        return () => {
            Promise.resolve(deactivateKeepAwake(KEEP_SCREEN_ON_TAG)).catch(() => {});
        };
    }, [keepOn]);

    return keepOn;
}
