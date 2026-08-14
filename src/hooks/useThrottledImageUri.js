import { useCallback, useEffect, useRef, useState } from 'react';
import ImageLoadQueue from '../services/ImageLoadQueue';

// Gates a grid tile's actual image request behind ImageLoadQueue, so only a
// bounded number of thumbnails are ever in flight to the NAS at once.
// Returns [uriToRender, onLoadSettled] -- uriToRender is null while the
// request is queued (render a placeholder), and onLoadSettled must be wired
// to the Image's onLoad/onError so its slot gets handed to the next waiter.
//
// If `targetUri` changes (FlashList recycled this component to a different
// photo) or the component unmounts before a slot was granted, the queued
// request is cancelled instead of wastefully waiting its turn for a photo
// nobody wants anymore.
export function useThrottledImageUri(targetUri) {
    // Tracks which uri the granted slot's state belongs to, not just the
    // resolved uri itself -- when a recycled tile's targetUri changes, the
    // effect below hasn't run yet on this render, so a bare `readyUri` state
    // would still hold the *previous* item's uri and briefly render the
    // wrong photo in this tile before the new request gets its turn. Deriving
    // readiness by comparing against the current targetUri (below) makes the
    // stale state resolve to "not ready" immediately, on the very same
    // render, instead of one or more renders later.
    const [granted, setGranted] = useState({ uri: null, forTargetUri: null });
    // 'idle' | 'waiting' | 'granted' | 'done'
    const stateRef = useRef('idle');

    useEffect(() => {
        if (!targetUri) {
            return undefined;
        }

        const id = {}; // unique per effect run, cheaper than a counter + Map
        stateRef.current = 'waiting';
        let live = true;

        ImageLoadQueue.schedule(id).then(() => {
            if (!live) {
                // Cleanup already ran (uri changed / unmounted) before this
                // request reached the front of the queue -- give the slot
                // straight back instead of rendering a photo nobody wants.
                ImageLoadQueue.release();
                return;
            }
            stateRef.current = 'granted';
            setGranted({ uri: targetUri, forTargetUri: targetUri });
        });

        return () => {
            live = false;
            if (stateRef.current === 'granted') {
                ImageLoadQueue.release();
            } else if (stateRef.current === 'waiting') {
                ImageLoadQueue.cancel(id);
            }
            stateRef.current = 'idle';
        };
    }, [targetUri]);

    const readyUri = granted.forTargetUri === targetUri ? granted.uri : null;

    const onLoadSettled = useCallback(() => {
        if (stateRef.current === 'granted') {
            ImageLoadQueue.release();
            stateRef.current = 'done';
        }
    }, []);

    return [readyUri, onLoadSettled];
}
