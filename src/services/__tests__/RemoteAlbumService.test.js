jest.mock('axios');
jest.mock('../AuthService', () => ({
  getServerUrl: jest.fn(() => 'http://localhost:8000'),
  getToken: jest.fn(() => 'test-token'),
}));

const axios = require('axios');
const AuthService = require('../AuthService');
import RemoteAlbumService from '../RemoteAlbumService';

beforeEach(() => {
  jest.clearAllMocks();
  AuthService.getServerUrl.mockReturnValue('http://localhost:8000');
  AuthService.getToken.mockReturnValue('test-token');
  RemoteAlbumService.rootCollection = undefined;
  axios.isCancel = jest.fn(() => false);
});

describe('getAlbums', () => {
  test('returns [] without making a request when server url/token are missing', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('handles a bare array response', async () => {
    axios.get.mockResolvedValue({ data: [{ ID: '1', Title: 'Trip' }] });
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toEqual([{ id: '1', name: 'Trip', coverImage: '', count: 0 }]);
  });

  test('handles a { Albums: [...] } wrapper', async () => {
    axios.get.mockResolvedValue({ data: { Albums: [{ ID: '1', Title: 'Trip' }] } });
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toHaveLength(1);
  });

  test('handles a lowercase { albums: [...] } wrapper', async () => {
    axios.get.mockResolvedValue({ data: { albums: [{ id: '1', name: 'Trip' }] } });
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toHaveLength(1);
  });

  test('normalizes whichever field-name casing the server used', async () => {
    axios.get.mockResolvedValue({
      data: [
        { ID: '1', Title: 'A', CoverImage: 'cover.jpg', AssetsCount: 5 },
        { id: '2', name: 'B', coverImage: 'cover2.jpg', count: 3 },
      ],
    });
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toEqual([
      { id: '1', name: 'A', coverImage: 'cover.jpg', count: 5 },
      { id: '2', name: 'B', coverImage: 'cover2.jpg', count: 3 },
    ]);
  });

  test('falls back to a generated id and placeholder name for a malformed entry', async () => {
    axios.get.mockResolvedValue({ data: [{}] });
    const result = await RemoteAlbumService.getAlbums();
    expect(result).toEqual([{ id: 'album_0', name: 'Unnamed Album', coverImage: '', count: 0 }]);
  });

  test('returns [] (not a rejection) on a network error', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    await expect(RemoteAlbumService.getAlbums()).resolves.toEqual([]);
  });

  test('returns [] on a canceled request too', async () => {
    axios.isCancel = jest.fn(() => true);
    axios.get.mockRejectedValue(new Error('canceled'));
    await expect(RemoteAlbumService.getAlbums()).resolves.toEqual([]);
  });
});

describe('getAlbumAssets', () => {
  test('returns [] when albumId is missing', async () => {
    const result = await RemoteAlbumService.getAlbumAssets(null);
    expect(result).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('handles a plain array of hash strings', async () => {
    axios.get.mockResolvedValue({ data: ['hash1', 'hash2'] });
    const result = await RemoteAlbumService.getAlbumAssets('album1');
    expect(result).toEqual(['hash1', 'hash2']);
  });

  test('handles an array of objects, preferring Hash/Name field variants', async () => {
    axios.get.mockResolvedValue({ data: [{ Hash: 'h1' }, { Name: 'n1' }, { hash: 'h2' }] });
    const result = await RemoteAlbumService.getAlbumAssets('album1');
    expect(result).toEqual(['h1', 'n1', 'h2']);
  });

  test('filters out entries with no usable identifier', async () => {
    axios.get.mockResolvedValue({ data: [{ Hash: 'h1' }, {}, { Hash: '' }] });
    const result = await RemoteAlbumService.getAlbumAssets('album1');
    expect(result).toEqual(['h1']);
  });

  test('returns [] on error', async () => {
    axios.get.mockRejectedValue(new Error('boom'));
    await expect(RemoteAlbumService.getAlbumAssets('album1')).resolves.toEqual([]);
  });
});

describe('addAssetToAlbum', () => {
  test('returns false when required params are missing', async () => {
    await expect(RemoteAlbumService.addAssetToAlbum(null, 'hash1')).resolves.toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns true on 200/201', async () => {
    axios.post.mockResolvedValue({ status: 200 });
    await expect(RemoteAlbumService.addAssetToAlbum('album1', 'hash1')).resolves.toBe(true);
  });

  test('treats a 500 response as success (asset likely already in the album)', async () => {
    axios.post.mockRejectedValue({ response: { status: 500 } });
    await expect(RemoteAlbumService.addAssetToAlbum('album1', 'hash1')).resolves.toBe(true);
  });

  test('returns false on other errors', async () => {
    axios.post.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    await expect(RemoteAlbumService.addAssetToAlbum('album1', 'hash1')).resolves.toBe(false);
  });
});

describe('removeAssetFromAlbum', () => {
  test('returns false when required params are missing', async () => {
    await expect(RemoteAlbumService.removeAssetFromAlbum('album1', null)).resolves.toBe(false);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('returns true on 200', async () => {
    axios.delete.mockResolvedValue({ status: 200 });
    await expect(RemoteAlbumService.removeAssetFromAlbum('album1', 'hash1')).resolves.toBe(true);
  });

  test('treats a 500 response as success (asset likely already removed)', async () => {
    axios.delete.mockRejectedValue({ response: { status: 500 } });
    await expect(RemoteAlbumService.removeAssetFromAlbum('album1', 'hash1')).resolves.toBe(true);
  });

  test('returns false on other errors', async () => {
    axios.delete.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    await expect(RemoteAlbumService.removeAssetFromAlbum('album1', 'hash1')).resolves.toBe(false);
  });
});

describe('createAlbum', () => {
  test('returns null without making a request when server url/token are missing', async () => {
    AuthService.getServerUrl.mockReturnValue(null);
    await expect(RemoteAlbumService.createAlbum('/Faces/alice')).resolves.toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns the normalized new album on success', async () => {
    axios.post.mockResolvedValue({ data: { ID: 'new1', Title: '/Faces/alice' } });
    await expect(RemoteAlbumService.createAlbum('/Faces/alice')).resolves.toEqual({
      id: 'new1', name: '/Faces/alice', count: 0,
    });
  });

  test('returns null if the server response has no ID', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await expect(RemoteAlbumService.createAlbum('/Faces/alice')).resolves.toBeNull();
  });

  test('propagates (does not swallow) errors, unlike the other write methods', async () => {
    axios.post.mockRejectedValue(new Error('server exploded'));
    await expect(RemoteAlbumService.createAlbum('/Faces/alice')).rejects.toThrow('server exploded');
  });
});

describe('updateAlbumInfo / deleteAlbum guard clauses', () => {
  test('updateAlbumInfo returns false when albumId is missing', async () => {
    await expect(RemoteAlbumService.updateAlbumInfo(null, 'New Title')).resolves.toBe(false);
    expect(axios.put).not.toHaveBeenCalled();
  });

  test('updateAlbumInfo returns true on success', async () => {
    axios.put.mockResolvedValue({ status: 200 });
    await expect(RemoteAlbumService.updateAlbumInfo('album1', 'New Title')).resolves.toBe(true);
  });

  test('updateAlbumInfo returns false on error', async () => {
    axios.put.mockRejectedValue(new Error('boom'));
    await expect(RemoteAlbumService.updateAlbumInfo('album1', 'New Title')).resolves.toBe(false);
  });

  test('deleteAlbum returns false when albumId is missing', async () => {
    await expect(RemoteAlbumService.deleteAlbum(null)).resolves.toBe(false);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('deleteAlbum returns true on success', async () => {
    axios.delete.mockResolvedValue({ status: 200 });
    await expect(RemoteAlbumService.deleteAlbum('album1')).resolves.toBe(true);
  });

  test('deleteAlbum returns false on error', async () => {
    axios.delete.mockRejectedValue(new Error('boom'));
    await expect(RemoteAlbumService.deleteAlbum('album1')).resolves.toBe(false);
  });
});

describe('tree helpers before any hierarchy has been fetched', () => {
  test('renameAlbumInTree / deleteAlbumFromTree return false without a rootCollection', () => {
    expect(RemoteAlbumService.renameAlbumInTree('a1', 'New', '/New')).toBe(false);
    expect(RemoteAlbumService.deleteAlbumFromTree('a1')).toBe(false);
  });

  test('getRootCollection returns undefined before getAlbumsHierarchy has run', () => {
    expect(RemoteAlbumService.getRootCollection()).toBeUndefined();
  });
});
