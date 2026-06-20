import axios from 'axios';
import AuthService from './AuthService';
import { LomoCollection } from '../models/LomoCollection';

class RemoteAlbumService {
  /**
   * Retrieves all albums from the server as a flat list.
   * @param {Object} options - Options like { priority, groupId }
   * @returns {Promise<Array>} Array of album objects.
   */
  async getAlbums(options = {}) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token) {
      console.warn('[RemoteAlbumService] No server URL or token available for getAlbums');
      return [];
    }

    try {
      const response = await axios.get(`${serverUrl}/album`, {
        headers: { Authorization: `token=${token}` },
        timeout: 10000,
        skipAutoProbe: true,
        priority: options.priority ?? 1,
        groupId: options.groupId ?? 'Albums'
      });
      let albumsData = [];
      if (Array.isArray(response.data)) {
        albumsData = response.data;
      } else if (response.data?.Albums) {
        albumsData = response.data.Albums;
      } else if (response.data?.albums) {
        albumsData = response.data.albums;
      }
      
      return albumsData.map((a, index) => ({
        id: a.ID || a.id || `album_${index}`,
        name: a.Title || a.title || a.name || a.Name || 'Unnamed Album',
        coverImage: a.CoverImage || a.coverImage || '',
        count: a.AssetsCount || a.assetsCount || a.count || a.Count || 0
      }));
    } catch (error) {
      if (axios.isCancel(error)) {
        console.log('[RemoteAlbumService] Fetching albums canceled');
      } else {
        console.error('[RemoteAlbumService] Error fetching albums:', error.message);
      }
      return [];
    }
  }

  /**
   * Retrieves all albums from the server and builds a hierarchical tree.
   * @param {Object} options - Options like { priority, groupId }
   * @returns {Promise<LomoCollection>} Root LomoCollection node.
   */
  async getAlbumsHierarchy(options = {}) {
    const flatAlbums = await this.getAlbums(options);
    this.rootCollection = LomoCollection.buildCollections(flatAlbums);
    return this.rootCollection;
  }

  getRootCollection() {
    return this.rootCollection;
  }

  renameAlbumInTree(albumId, newName, newFullPath) {
    if (this.rootCollection) {
        return this.rootCollection.renameAlbum(albumId, newName, newFullPath);
    }
    return false;
  }

  deleteAlbumFromTree(albumId) {
    if (this.rootCollection) {
        return this.rootCollection.deleteAlbum(albumId);
    }
    return false;
  }

  /**
   * Retrieves all assets inside a specific album.
   * @param {string} albumId - The ID of the album.
   * @param {Object} options - Options like { priority, groupId }
   * @returns {Promise<Array>} Array of asset hashes.
   */
  async getAlbumAssets(albumId, options = {}) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token || !albumId) {
      console.warn('[RemoteAlbumService] Missing requirements for getAlbumAssets');
      return [];
    }

    try {
      const response = await axios.get(`${serverUrl}/album/${albumId}/assets`, {
        params: { hash: 1, page: 0 },
        headers: { Authorization: `token=${token}` },
        skipAutoProbe: true,
        timeout: 10000,
        priority: options.priority ?? 1,
        groupId: options.groupId ?? 'AlbumDetail'
      });
      const data = response.data || [];
      // API returns array of objects { Name, Hash } or strings depending on version/params
      return data.map(item => typeof item === 'string' ? item : (item.Hash || item.Name || item.hash || item.name)).filter(Boolean);
    } catch (error) {
      if (axios.isCancel(error)) {
        console.log(`[RemoteAlbumService] Fetching assets for album ${albumId} canceled`);
      } else {
        console.error(`[RemoteAlbumService] Error fetching assets for album ${albumId}:`, error.message);
      }
      return [];
    }
  }

  /**
   * Adds an asset to a specific album.
   * @param {string} albumId - The ID of the album.
   * @param {string} assetHash - The hash (ID) of the asset to add.
   * @returns {Promise<boolean>} True if successful.
   */
  async addAssetToAlbum(albumId, assetHash) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token || !albumId || !assetHash) {
      console.warn('[RemoteAlbumService] Missing requirements for addAssetToAlbum');
      return false;
    }

    try {
      const response = await axios.post(
        `${serverUrl}/album/${albumId}/assets`,
        JSON.stringify([assetHash]),
        { headers: { Authorization: `token=${token}`, 'Content-Type': 'application/json' } }
      );
      return response.status === 200 || response.status === 201;
    } catch (error) {
      if (error.response && error.response.status === 500) {
        console.warn(`[RemoteAlbumService] 500 error adding asset ${assetHash} to album ${albumId}. Likely already exists. Ignoring.`);
        return true;
      }
      console.error(`[RemoteAlbumService] Error adding asset ${assetHash} to album ${albumId}:`, error.message);
      return false;
    }
  }

  /**
   * Removes an asset from a specific album.
   * @param {string} albumId - The ID of the album.
   * @param {string} assetHash - The hash (ID) of the asset to remove.
   * @returns {Promise<boolean>} True if successful.
   */
  async removeAssetFromAlbum(albumId, assetHash) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token || !albumId || !assetHash) {
      console.warn('[RemoteAlbumService] Missing requirements for removeAssetFromAlbum');
      return false;
    }

    try {
      const response = await axios.delete(
        `${serverUrl}/album/${albumId}/assets`,
        {
          data: JSON.stringify([assetHash]),
          headers: { Authorization: `token=${token}`, 'Content-Type': 'application/json' }
        }
      );
      return response.status === 200;
    } catch (error) {
      if (error.response && error.response.status === 500) {
        console.warn(`[RemoteAlbumService] 500 error removing asset ${assetHash} from album ${albumId}. Likely doesn't exist. Ignoring.`);
        return true;
      }
      console.error(`[RemoteAlbumService] Error removing asset ${assetHash} from album ${albumId}:`, error.message);
      return false;
    }
  }

  /**
   * Creates a new album on the server
   * @param {string} title 
   */
  async createAlbum(title) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token) return null;

    try {
      const response = await axios.post(`${serverUrl}/album`, {
        Title: title,
        Description: "",
        Author: "Lomorage User" // We can just use a generic or empty string if username isn't easily accessible
      }, {
        headers: { 
          Authorization: `token=${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        skipAutoProbe: true
      });
      const a = response.data;
      if (a && a.ID) {
        return {
          id: a.ID,
          name: a.Title,
          count: 0
        };
      }
      return null;
    } catch (e) {
      console.error(`Failed to create album: ${title}`, e);
      throw e;
    }
  }

  /**
   * Updates an album's information on the server
   * @param {string} albumId 
   * @param {string} title 
   * @returns {Promise<boolean>}
   */
  async updateAlbumInfo(albumId, title) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token || !albumId) return false;

    // Find existing album to preserve its CoverImage
    let existingCoverImage = "";
    if (this.rootCollection) {
        let found = null;
        const findAlbum = (collection) => {
            for (const album of collection.albums.values()) {
                if (String(album.info.id) === String(albumId)) {
                    found = album;
                    return;
                }
            }
            if (!found) {
                for (const folder of collection.folders.values()) {
                    findAlbum(folder);
                    if (found) return;
                }
            }
        };
        findAlbum(this.rootCollection);
        if (found && found.info.coverImage) {
            existingCoverImage = found.info.coverImage;
        }
    }

    try {
      const response = await axios.put(`${serverUrl}/album`, {
        ID: parseInt(albumId, 10),
        Title: title,
        Description: "",
        Author: "Lomorage User",
        CoverImage: existingCoverImage
      }, {
        headers: { 
          Authorization: `token=${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        skipAutoProbe: true
      });
      return response.status === 200;
    } catch (error) {
      console.error(`[RemoteAlbumService] Error updating album ${albumId}:`, error.message);
      return false;
    }
  }

  /**
   * Deletes an album from the server
   * @param {string} albumId 
   * @returns {Promise<boolean>}
   */
  async deleteAlbum(albumId) {
    const serverUrl = AuthService.getServerUrl();
    const token = AuthService.getToken();
    if (!serverUrl || !token || !albumId) return false;

    try {
      const response = await axios.delete(`${serverUrl}/album/${albumId}`, {
        headers: { Authorization: `token=${token}` },
        timeout: 10000,
        skipAutoProbe: true
      });
      return response.status === 200;
    } catch (error) {
      console.error(`[RemoteAlbumService] Error deleting album ${albumId}:`, error.message);
      return false;
    }
  }
}

export default new RemoteAlbumService();
