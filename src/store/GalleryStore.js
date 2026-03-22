class GalleryStore {
    constructor() {
        this.assets = [];
        this.listeners = new Set();
    }

    setAssets(assets) {
        this.assets = assets;
        this.notify();
    }

    getAssets() {
        return this.assets;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener); // return unsubscribe function
    }

    notify() {
        this.listeners.forEach(listener => listener(this.assets));
    }
}

export default new GalleryStore();
