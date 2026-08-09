import { LomoCollection, LomoAlbum } from '../LomoCollection';

describe('LomoCollection.buildCollections', () => {
  test('a top-level name (no slashes) becomes a direct album, no folders', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: 'Vacation' }]);
    expect(root.folders.size).toBe(0);
    expect(root.albums.has('Vacation')).toBe(true);
    expect(root.albums.get('Vacation').info.id).toBe('1');
  });

  test('a slash-separated name builds nested folders with the album at the leaf', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.albums.size).toBe(0);
    const faces = root.folders.get('Faces');
    expect(faces).toBeDefined();
    expect(faces.albums.has('alice')).toBe(true);
    expect(faces.albums.get('alice').info.id).toBe('1');
  });

  test('deeper nesting builds multiple folder levels', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Trips/2024/Hawaii' }]);
    const trips = root.folders.get('Trips');
    const year = trips.folders.get('2024');
    expect(year.albums.has('Hawaii')).toBe(true);
  });

  test('a leading slash does not create an empty-string folder', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.folders.has('')).toBe(false);
  });

  test('two albums sharing a folder prefix reuse the same folder instead of duplicating it', () => {
    const root = LomoCollection.buildCollections([
      { id: '1', name: '/Faces/alice' },
      { id: '2', name: '/Faces/bob' },
    ]);
    expect(root.folders.size).toBe(1);
    const faces = root.folders.get('Faces');
    expect(faces.albums.size).toBe(2);
  });

  test('missing or empty name falls back to "Unnamed Album" at the root', () => {
    const root = LomoCollection.buildCollections([{ id: '1' }, { id: '2', name: '   ' }]);
    // Both map to the same 'Unnamed Album' key, so the second overwrites... no, addAlbum
    // dedupes by name and keeps the first — verifies that behavior explicitly.
    expect(root.albums.get('Unnamed Album').info.id).toBe('1');
  });

  test('folders get their fullPath set relative to their parent', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Trips/2024/Hawaii' }]);
    const trips = root.folders.get('Trips');
    const year = trips.folders.get('2024');
    expect(trips.fullPath).toBe('Trips');
    expect(year.fullPath).toBe('Trips/2024');
  });
});

describe('LomoCollection.getItems', () => {
  test('lists both folders and albums with distinguishing type/key', () => {
    const root = LomoCollection.buildCollections([
      { id: '1', name: 'TopLevel' },
      { id: '2', name: '/Faces/alice' },
    ]);
    const items = root.getItems();
    expect(items).toHaveLength(2);
    expect(items.find(i => i.type === 'album').key).toBe('album_1');
    expect(items.find(i => i.type === 'folder').key).toBe('folder_Faces');
  });
});

describe('LomoCollection.getCollectionByPath', () => {
  test('returns itself for an empty/falsy path', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.getCollectionByPath('')).toBe(root);
    expect(root.getCollectionByPath(null)).toBe(root);
  });

  test('navigates nested folders by path', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Trips/2024/Hawaii' }]);
    const found = root.getCollectionByPath('Trips/2024');
    expect(found.name).toBe('2024');
  });

  test('returns null for a path that does not exist', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.getCollectionByPath('DoesNotExist')).toBeNull();
  });
});

describe('LomoCollection.renameAlbum', () => {
  test('renames an album at the root by id', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: 'Old Name' }]);
    const renamed = root.renameAlbum('1', 'New Name', '/New Name');
    expect(renamed).toBe(true);
    expect(root.albums.has('Old Name')).toBe(false);
    expect(root.albums.get('New Name').info.id).toBe('1');
    expect(root.albums.get('New Name').info.name).toBe('/New Name');
  });

  test('recurses into subfolders to find the album', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    const renamed = root.renameAlbum('1', 'alice-renamed');
    expect(renamed).toBe(true);
    expect(root.folders.get('Faces').albums.has('alice-renamed')).toBe(true);
  });

  test('returns false when the album id is not found anywhere', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.renameAlbum('nonexistent', 'X')).toBe(false);
  });

  test('matches the id loosely (string vs number)', () => {
    const root = LomoCollection.buildCollections([{ id: 1, name: 'Album' }]);
    expect(root.renameAlbum('1', 'Renamed')).toBe(true);
  });
});

describe('LomoCollection.deleteAlbum', () => {
  test('deletes an album at the root by id', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: 'ToDelete' }]);
    expect(root.deleteAlbum('1')).toBe(true);
    expect(root.albums.size).toBe(0);
  });

  test('recurses into subfolders to find and delete the album', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.deleteAlbum('1')).toBe(true);
    expect(root.folders.get('Faces').albums.size).toBe(0);
  });

  test('returns false when the album id is not found anywhere', () => {
    const root = LomoCollection.buildCollections([{ id: '1', name: '/Faces/alice' }]);
    expect(root.deleteAlbum('nonexistent')).toBe(false);
  });

  test('deleting one album leaves sibling albums in the same folder intact', () => {
    const root = LomoCollection.buildCollections([
      { id: '1', name: '/Faces/alice' },
      { id: '2', name: '/Faces/bob' },
    ]);
    root.deleteAlbum('1');
    const faces = root.folders.get('Faces');
    expect(faces.albums.has('alice')).toBe(false);
    expect(faces.albums.has('bob')).toBe(true);
  });
});

describe('LomoAlbum', () => {
  test('stores name, info, and starts with no parent', () => {
    const album = new LomoAlbum('MyAlbum', { id: '1' });
    expect(album.name).toBe('MyAlbum');
    expect(album.info).toEqual({ id: '1' });
    expect(album.parent).toBeNull();
  });
});
