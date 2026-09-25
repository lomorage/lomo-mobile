import RemoteAlbumService from '../../src/services/RemoteAlbumService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll } from '../support/cameraRoll';
import { registerUser, startTestServer } from '../support/harness';

const server = startTestServer('albums');

describe('remote albums on lomod', () => {
  let photo1;
  let photo2;

  beforeAll(async () => {
    await registerUser(server);
    ({ hash: photo1 } = await UploadService.uploadAsset(addToCameraRoll('photo-2003-11-01.jpg')));
    ({ hash: photo2 } = await UploadService.uploadAsset(addToCameraRoll('photo-2003-11-23.jpg')));
  });

  const albumNamed = async (name) => (await RemoteAlbumService.getAlbums()).find((a) => a.name === name);

  it('creates an album that then shows up in the album list', async () => {
    const created = await RemoteAlbumService.createAlbum('Trip');

    expect(created).toMatchObject({ name: 'Trip', count: 0 });
    expect(await albumNamed('Trip')).toMatchObject({ id: created.id });
  });

  it('adds and removes assets', async () => {
    const { id } = await albumNamed('Trip');

    expect(await RemoteAlbumService.addAssetToAlbum(id, photo1)).toBe(true);
    expect(await RemoteAlbumService.addAssetToAlbum(id, photo2)).toBe(true);
    expect((await RemoteAlbumService.getAlbumAssets(id)).sort()).toEqual([photo1, photo2].sort());
    // The album list's count drives the "N photos" label and the merge default name.
    expect((await albumNamed('Trip')).count).toBe(2);

    expect(await RemoteAlbumService.removeAssetFromAlbum(id, photo1)).toBe(true);
    expect(await RemoteAlbumService.getAlbumAssets(id)).toEqual([photo2]);
  });

  it('renames an album', async () => {
    const { id } = await albumNamed('Trip');
    await RemoteAlbumService.getAlbumsHierarchy();

    expect(await RemoteAlbumService.updateAlbumInfo(id, 'Trip 2003')).toBe(true);

    expect(await albumNamed('Trip 2003')).toMatchObject({ id });
    expect(await albumNamed('Trip')).toBeUndefined();
  });

  it('merges albums into one holding the union of their assets', async () => {
    const other = await RemoteAlbumService.createAlbum('More');
    await RemoteAlbumService.addAssetToAlbum(other.id, photo1);
    const { id } = await albumNamed('Trip 2003');

    expect(await RemoteAlbumService.mergeAlbums([id, other.id], 'Merged')).toBe(true);

    const albums = await RemoteAlbumService.getAlbums();
    expect(albums.map((a) => a.name)).toEqual(['Merged']);
    expect((await RemoteAlbumService.getAlbumAssets(albums[0].id)).sort()).toEqual([photo1, photo2].sort());
  });

  it('deletes an album', async () => {
    const { id } = await albumNamed('Merged');

    expect(await RemoteAlbumService.deleteAlbum(id)).toBe(true);

    expect(await RemoteAlbumService.getAlbums()).toEqual([]);
  });
});
