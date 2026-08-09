import GalleryStore from '../GalleryStore';

beforeEach(() => {
  GalleryStore.assetsBySource = { gallery: [] };
  GalleryStore.listeners = new Set();
});

describe('setAssets / getAssets', () => {
  test('defaults to the "gallery" source', () => {
    GalleryStore.setAssets([{ id: 1 }]);
    expect(GalleryStore.getAssets()).toEqual([{ id: 1 }]);
  });

  test('keeps separate sources independent', () => {
    GalleryStore.setAssets([{ id: 1 }], 'gallery');
    GalleryStore.setAssets([{ id: 2 }], 'onThisDay');
    expect(GalleryStore.getAssets('gallery')).toEqual([{ id: 1 }]);
    expect(GalleryStore.getAssets('onThisDay')).toEqual([{ id: 2 }]);
  });

  test('getAssets returns an empty array for a source that was never set', () => {
    expect(GalleryStore.getAssets('neverSet')).toEqual([]);
  });
});

describe('subscribe / notify', () => {
  test('setAssets notifies subscribed listeners with the new assets and source', () => {
    const listener = jest.fn();
    GalleryStore.subscribe(listener);
    GalleryStore.setAssets([{ id: 1 }], 'gallery');
    expect(listener).toHaveBeenCalledWith([{ id: 1 }], 'gallery');
  });

  test('notifies all subscribed listeners, not just the first', () => {
    const a = jest.fn();
    const b = jest.fn();
    GalleryStore.subscribe(a);
    GalleryStore.subscribe(b);
    GalleryStore.setAssets([{ id: 1 }]);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test('the returned unsubscribe function stops further notifications', () => {
    const listener = jest.fn();
    const unsubscribe = GalleryStore.subscribe(listener);
    unsubscribe();
    GalleryStore.setAssets([{ id: 1 }]);
    expect(listener).not.toHaveBeenCalled();
  });

  test('a listener for one source still fires on updates to a different source (notify is global, not per-source)', () => {
    const listener = jest.fn();
    GalleryStore.subscribe(listener);
    GalleryStore.setAssets([{ id: 1 }], 'onThisDay');
    expect(listener).toHaveBeenCalledWith([{ id: 1 }], 'onThisDay');
  });
});
