import { useState, useEffect } from 'react';
import { DeviceEventEmitter } from 'react-native';

// Bumps whenever AuthService switches the active server URL (e.g. dual-connection
// failover finding a faster local path after starting on a slow remote relay).
// Screens that bake a server-derived preview URL into state/render once, rather than
// re-deriving it every render, need this to know when to force those images to
// reload -- append `_r=${serverEpoch}` (or combine with a retry tick, see
// useImageRetry) to the image URI to bust the cache and retrigger the load.
export function useServerEpoch() {
    const [serverEpoch, setServerEpoch] = useState(0);
    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('onServerUrlChanged', () => {
            setServerEpoch(prev => prev + 1);
        });
        return () => sub.remove();
    }, []);
    return serverEpoch;
}
