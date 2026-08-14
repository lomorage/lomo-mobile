// The NAS this app talks to has ~858MB of RAM and caps its own preview
// concurrency at 3 (see lomod's --max-fetch-preview flag). A fast-scrolling
// or freshly-mounted photo grid can otherwise fire off hundreds of thumbnail
// requests within a couple seconds, which the NAS accepts and queues rather
// than rejects -- burning memory/swap until requests take 10s+ and start
// timing out on the client. This throttles how many thumbnail loads the app
// itself will have in flight at once, queuing the rest client-side (where
// waiting is free) instead of handing them all to the server at once.
const MAX_CONCURRENT = 4;

class ImageLoadQueue {
    constructor() {
        this.active = 0;
        this.queue = []; // [{ id, resolve }], most-recently-queued at the end
    }

    // Resolves once a load slot is granted -- immediately if one's free,
    // otherwise after enough earlier requests call release()/cancel().
    schedule(id) {
        return new Promise((resolve) => {
            if (this.active < MAX_CONCURRENT) {
                this.active++;
                resolve();
            } else {
                this.queue.push({ id, resolve });
            }
        });
    }

    // Drops a still-queued request, e.g. because the grid tile that wanted
    // it scrolled away or got recycled to a different photo before its turn
    // came up. No-ops if `id` already got a slot (or was never queued).
    cancel(id) {
        const index = this.queue.findIndex((entry) => entry.id === id);
        if (index !== -1) {
            this.queue.splice(index, 1);
        }
    }

    // Frees a slot held by a request that already got one (its image finished
    // loading, errored, or the caller gave it up after granting), and hands
    // that slot to the next queued request, if any.
    //
    // Most-recently-queued first (LIFO), not arrival order. During a scroll,
    // "most recently asked for" tracks "closest to what's on screen right
    // now" far better than "asked for first" does -- a fast fling can queue
    // up dozens of requests for tiles that have already scrolled past by the
    // time earlier ones would reach the front of a FIFO queue, so a strict
    // FIFO makes the photos the user is actually looking at right now wait
    // behind a backlog of ones they've already scrolled away from. (The web
    // client sidesteps this differently -- it never builds a backlog at all,
    // keeping only ~2-3 screens worth of thumbnails in the DOM at once. Doing
    // the same here would mean tightening FlashList's drawDistance; LIFO is
    // the cheaper fix for the same underlying "stale requests block fresh
    // ones" problem.)
    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.pop();
        if (next) {
            this.active++;
            next.resolve();
        }
    }
}

export default new ImageLoadQueue();
