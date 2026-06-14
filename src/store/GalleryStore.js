class GalleryStore {
    constructor() {
        this.assetsBySource = {
            'gallery': []
        };
        this.listeners = new Set();
    }

    setAssets(assets, source = 'gallery') {
        this.assetsBySource[source] = assets;
        this.notify(source);
    }

    getAssets(source = 'gallery') {
        return this.assetsBySource[source] || [];
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener); // return unsubscribe function
    }

    notify(source) {
        this.listeners.forEach(listener => listener(this.assetsBySource[source], source));
    }
}

export default new GalleryStore();
