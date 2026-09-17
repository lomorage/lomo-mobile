import { useRef, useState, useEffect, useCallback } from 'react';
import { isNotFoundImageError } from '../utils/imageErrors';
import ImageLoadGate from '../services/ImageLoadGate';

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
            // expo-image's own load timeout (~10s) fires well before this NAS finishes a
            // slow preview under load (15-20s+ observed in lomod_access.log) -- the old
            // 1s/3s/6s backoff meant the retry's fresh, cache-busted request nearly always
            // landed while the original was *still being generated server-side*, doubling
            // (then tripling) load on the exact request that was already too slow. Backing
            // off longer than the server's real response time lets the original finish and
            // get cached, so the retry is normally a cheap served-from-cache hit instead of
            // triggering duplicate work.
            const backoffMs = [10000, 20000, 30000][attempt - 1];
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

// Withholds a remote (http) preview URI from the Image component until ImageLoadGate
// grants a concurrency slot, so a burst of newly-mounted grid cells doesn't all hit the
// NAS at once. Local URIs (device photos, content://, ph://, ...) are never gated --
// returned synchronously on first render, no extra render pass, no placeholder flash.
// Caller must invoke the returned `release()` from both onLoad and onError so the slot
// is freed as soon as the load settles either way.
export function useGatedImageUri(uri) {
    const isRemote = !!uri && uri.startsWith('http');
    const [gatedRemoteUri, setGatedRemoteUri] = useState(null);
    const tokenRef = useRef(null);
    const pendingUriRef = useRef(null);

    useEffect(() => {
        if (!isRemote) {
            if (tokenRef.current) {
                ImageLoadGate.cancel(tokenRef.current);
                tokenRef.current = null;
            }
            pendingUriRef.current = null;
            return;
        }
        if (pendingUriRef.current === uri) return; // already granted/pending for this exact uri
        pendingUriRef.current = uri;

        if (tokenRef.current) {
            ImageLoadGate.cancel(tokenRef.current);
            tokenRef.current = null;
        }
        setGatedRemoteUri(null);

        let isCurrent = true;
        ImageLoadGate.acquire().then(token => {
            if (!isCurrent) {
                ImageLoadGate.cancel(token);
                return;
            }
            tokenRef.current = token;
            setGatedRemoteUri(uri);
        });

        return () => { isCurrent = false; };
    }, [uri, isRemote]);

    const release = useCallback(() => {
        if (tokenRef.current) {
            ImageLoadGate.cancel(tokenRef.current);
            tokenRef.current = null;
        }
    }, []);

    return { gatedUri: isRemote ? gatedRemoteUri : uri, release };
}
