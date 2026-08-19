import { useRef, useState, useEffect, useCallback } from 'react';
import { isNotFoundImageError } from '../utils/imageErrors';

// Retries a failed remote preview load a few times with backoff, matching the pattern
// HomeScreen's RenderAsset/OnThisDayTile use for the main grid. A 404 means the server
// genuinely has no record of this hash (stale/orphaned reference) rather than a
// transient blip, so it's excluded -- retrying would just repeat the same failure.
// `resetKey` (typically the asset's id/hash) clears retry state when the underlying
// asset changes under a recycled component instance.
export function useImageRetry(resetKey) {
    const retryCountRef = useRef(0);
    const retryTimeoutRef = useRef(null);
    const [retryTick, setRetryTick] = useState(0);

    useEffect(() => {
        retryCountRef.current = 0;
        setRetryTick(0);
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    }, [resetKey]);

    useEffect(() => () => {
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    }, []);

    const onError = useCallback((e) => {
        const errorMessage = e?.error || e?.nativeEvent?.error;
        if (retryCountRef.current < 3 && !isNotFoundImageError(errorMessage)) {
            const attempt = retryCountRef.current + 1;
            retryCountRef.current = attempt;
            const backoffMs = [1000, 3000, 6000][attempt - 1];
            retryTimeoutRef.current = setTimeout(() => {
                setRetryTick(t => t + 1);
            }, backoffMs);
        }
    }, []);

    return { retryTick, onError };
}

// Appends a cache-busting suffix to a preview URI when either the server changed or a
// retry is in flight -- the bare URL string alone won't re-trigger the image loader.
export function withRetryBuster(uri, serverEpoch, retryTick) {
    if (!uri || (retryTick <= 0 && serverEpoch <= 0)) return uri;
    return `${uri}${uri.includes('?') ? '&' : '?'}_r=${serverEpoch}.${retryTick}`;
}
