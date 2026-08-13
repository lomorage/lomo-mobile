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
        // Keyed by the album's stable server id, not its display name: two
        // different albums (e.g. a freshly merged one and an unrelated one)
        // can easily end up with the same display name, and keying by name
        // used to silently drop the second one -- it just never appeared
        // anywhere in the UI even though it existed fine on the server.
        const key = album.info.id;
        if (this.albums.has(key)) {
            return this.albums.get(key);
        }
        this.albums.set(key, album);
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

    renameAlbum(albumId, newName, newFullPath) {
        // No re-keying needed now that albums are keyed by id, not name --
        // which also means renaming one album to another's existing name no
        // longer silently overwrites it in the map.
        for (const album of this.albums.values()) {
            if (String(album.info.id) === String(albumId)) {
                album.name = newName;
                if (newFullPath) album.info.name = newFullPath;
                return true;
            }
        }
        for (const folder of this.folders.values()) {
            if (folder.renameAlbum(albumId, newName, newFullPath)) return true;
        }
        return false;
    }

    deleteAlbum(albumId) {
        for (const [key, album] of this.albums.entries()) {
            if (String(album.info.id) === String(albumId)) {
                this.albums.delete(key);
                return true;
            }
        }
        for (const folder of this.folders.values()) {
            if (folder.deleteAlbum(albumId)) return true;
        }
        return false;
    }
}
