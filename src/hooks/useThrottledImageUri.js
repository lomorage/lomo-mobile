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
    const [readyUri, setReadyUri] = useState(null);
    // 'idle' | 'waiting' | 'granted' | 'done'
    const stateRef = useRef('idle');

    useEffect(() => {
        if (!targetUri) {
            setReadyUri(null);
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
            setReadyUri(targetUri);
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

    const onLoadSettled = useCallback(() => {
        if (stateRef.current === 'granted') {
            ImageLoadQueue.release();
            stateRef.current = 'done';
        }
    }, []);

    return [readyUri, onLoadSettled];
}
