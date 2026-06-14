export class LomoAlbum {
    constructor(name, info) {
        this.name = name;
        this.info = info; // { id, name (full title), coverImage, count }
        this.parent = null;
    }
}

export class LomoCollection {
    constructor(name = '') {
        this.name = name;
        this.parent = null;
        this.folders = new Map(); // string -> LomoCollection
        this.albums = new Map(); // string -> LomoAlbum
        this.fullPath = '';
    }

    /**
     * Builds a tree of collections and albums from a flat list of album infos.
     * @param {Array} albumsInfo - Flat array of albums from the server.
     * @returns {LomoCollection} The root collection.
     */
    static buildCollections(albumsInfo) {
        const root = new LomoCollection('');
        for (const info of albumsInfo) {
            root.build(info);
        }
        return root;
    }

    build(info) {
        if (!info.name) {
            this.addAlbum(new LomoAlbum('Unnamed Album', info));
            return;
        }

        // Split the path by '/' and remove any empty strings (e.g. leading slash)
        const elems = info.name.split('/').filter(e => e.trim().length > 0);
        
        if (elems.length === 0) {
            this.addAlbum(new LomoAlbum('Unnamed Album', info));
            return;
        }

        let curr = this;
        for (let i = 0; i < elems.length; i++) {
            const elem = elems[i];
            if (i !== elems.length - 1) {
                // It's a directory
                curr = curr.addCollection(new LomoCollection(elem));
            } else {
                // It's the final album
                curr.addAlbum(new LomoAlbum(elem, info));
            }
        }
    }

    addCollection(collection) {
        if (this.folders.has(collection.name)) {
            return this.folders.get(collection.name);
        }
        this.folders.set(collection.name, collection);
        collection.fullPath = this.fullPath ? `${this.fullPath}/${collection.name}` : collection.name;
        collection.parent = this;
        return collection;
    }

    addAlbum(album) {
        if (this.albums.has(album.name)) {
            return this.albums.get(album.name);
        }
        this.albums.set(album.name, album);
        album.parent = this;
        return album;
    }

    getItems() {
        const items = [];
        for (const folder of this.folders.values()) {
            items.push({ type: 'folder', data: folder, key: `folder_${folder.fullPath}` });
        }
        for (const album of this.albums.values()) {
            items.push({ type: 'album', data: album, key: `album_${album.info.id}` });
        }
        return items;
    }

    getCollectionByPath(path) {
        if (!path) return this;
        const elems = path.split('/').filter(e => e.trim().length > 0);
        let curr = this;
        for (const elem of elems) {
            if (curr.folders.has(elem)) {
                curr = curr.folders.get(elem);
            } else {
                return null;
            }
        }
        return curr;
    }
}
