// Caps how many remote thumbnail/preview network requests the app allows in flight at
// once. expo-image's native fetch bypasses NetworkQueue entirely (that only covers our
// own axios calls), and FlashList's drawDistance can mount dozens of grid cells during
// a fast scroll -- without this, every one of them fires its own request the instant it
// mounts. On a NAS that only usefully serves a handful of previews in parallel (this
// one is started with --max-fetch-preview 3, see lomorage-nas-hardware-constraints
// memory), the excess requests don't get more total throughput, they just sit queued
// server-side holding resources and inflating the measured latency of every request
// still in the queue -- including the handful the server could otherwise have finished
// quickly. Moving that queuing to the client (free to wait, costs nothing) instead of
// the server (a held goroutine + buffers per pending request) is a straight win.
const MAX_CONCURRENT = 3;

class ImageLoadGate {
  constructor() {
    this.activeCount = 0;
    this.queue = [];
  }

  // Resolves with a token once a slot is available (immediately if one already is).
  // Call release(token) when the load settles (onLoad/onError), or cancel(token) if
  // the request is no longer wanted (recycled to a different asset, or unmounted,
  // before a slot was granted).
  acquire() {
    if (this.activeCount < MAX_CONCURRENT) {
      this.activeCount++;
      return Promise.resolve({ granted: true });
    }
    const token = { granted: false };
    return new Promise(resolve => {
      token.resolve = resolve;
      this.queue.push(token);
    });
  }

  release(token) {
    if (!token || !token.granted) return;
    token.granted = false;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this._processQueue();
  }

  cancel(token) {
    if (!token) return;
    if (token.granted) {
      this.release(token);
      return;
    }
    const idx = this.queue.indexOf(token);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  _processQueue() {
    while (this.activeCount < MAX_CONCURRENT && this.queue.length > 0) {
      const token = this.queue.shift();
      this.activeCount++;
      token.granted = true;
      token.resolve(token);
    }
  }
}

export default new ImageLoadGate();
