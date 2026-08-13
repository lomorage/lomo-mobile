// Tracks how many remote thumbnail image requests are currently in flight in the
// gallery grid. Background sync tasks (e.g. SyncService's GPS backfill) poll this
// to back off while the user is actively looking at thumbnails, since both compete
// for the same constrained NAS preview-generation capacity.
class ThumbnailLoadTracker {
    constructor() {
        this.activeCount = 0;
    }

    increment() {
        this.activeCount++;
    }

    decrement() {
        this.activeCount = Math.max(0, this.activeCount - 1);
    }

    isActive() {
        return this.activeCount > 0;
    }
}

export default new ThumbnailLoadTracker();
