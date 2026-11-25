import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import AssetDBService from './AssetDBService';
import RemoteAlbumService from './RemoteAlbumService';

// Albums on the phone are where photos are grouped ("Lucrari", "Holiday 2025"). Only the files
// are backed up, so once Free Up Space deletes a photo from the phone, which albums it was in is
// gone: on Android an album is just the folder the file sat in. Before deleting, this copies that
// grouping to albums of the same name on the Lomorage server.

const PAGE_SIZE = 500;
const DIRECT_LOOKUP_MAX = 20;
const ADD_BATCH = 200;

// Android puts every photo the camera takes in a "Camera" folder. Copying it would make one
// album holding most of the library, which groups nothing.
const isSkippedAlbum = (album) => Platform.OS === 'android' && /^camera$/i.test((album.title || '').trim());

// Lomorage reads "/" in an album name as a folder ("2024/25 Season" would become album "25 Season"
// in folder "2024"), so it is replaced in the name used on the server.
export const serverAlbumName = (title) => title.trim().replace(/\//g, '-');

const toPhoneId = (id) => (typeof id === 'string' && id.startsWith('local-') ? id.slice('local-'.length) : id);

class PhoneAlbumService {
  /**
   * Finds which phone albums the given photos are in.
   * @param {string[]} ids phone asset ids (with or without the app's "local-" prefix)
   * @returns {Promise<Array<{ title: string, ids: string[] }>>} albums holding at least one of them
   */
  async findAlbumMembership(ids) {
    const wanted = new Set(ids.map(toPhoneId));
    if (wanted.size === 0) return [];
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
    // A few photos on Android: each one knows its album (folder), so ask them instead of reading
    // every album -- a camera photo would otherwise mean reading the whole library.
    if (Platform.OS === 'android' && wanted.size <= DIRECT_LOOKUP_MAX) {
      return this._membershipFromAssets([...wanted], albums);
    }
    const result = [];
    // On Android a photo is in exactly one album (its folder), so the search can stop once every
    // photo has been found. On iOS a photo can be in several.
    const found = new Set();
    for (const album of albums) {
      if (Platform.OS === 'android' && found.size === wanted.size) break;
      if (!album || !album.title || isSkippedAlbum(album) || album.assetCount === 0) continue;
      const members = [];
      let after;
      for (;;) {
        const page = await MediaLibrary.getAssetsAsync({
          album: album.id,
          first: PAGE_SIZE,
          after,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        });
        for (const asset of page.assets) {
          if (wanted.has(asset.id)) {
            members.push(asset.id);
            found.add(asset.id);
          }
        }
        if (!page.hasNextPage || !page.endCursor || page.assets.length === 0) break;
        after = page.endCursor;
      }
      if (members.length > 0) result.push({ title: serverAlbumName(album.title), ids: members });
    }
    return result;
  }

  async _membershipFromAssets(ids, albums) {
    const albumById = new Map(albums.map(album => [String(album.id), album]));
    const byTitle = new Map();
    for (const id of ids) {
      const info = await MediaLibrary.getAssetInfoAsync(id);
      const album = info && info.albumId != null ? albumById.get(String(info.albumId)) : null;
      if (!album || !album.title || isSkippedAlbum(album)) continue;
      const title = serverAlbumName(album.title);
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(id);
    }
    return [...byTitle.entries()].map(([title, members]) => ({ title, ids: members }));
  }

  /**
   * Copies the phone-album membership of the given photos to same-named server albums, creating
   * an album the server doesn't have. Safe to run again: photos already in the server album are
   * left as they are. Throws when it couldn't finish, so the caller can hold off deleting.
   * @param {string[]} ids phone asset ids about to be deleted from the phone
   * @returns {Promise<{ albums: number, added: number }>}
   */
  async copyAlbumsToServer(ids) {
    const membership = await this.findAlbumMembership(ids);
    if (membership.length === 0) return { albums: 0, added: 0 };

    const memberIds = [...new Set(membership.flatMap(album => album.ids))];
    const rows = await AssetDBService.getBackupRowsByIds(memberIds);
    const hashById = new Map(rows.filter(row => row.hash).map(row => [row.id, row.hash]));

    const serverAlbums = await RemoteAlbumService.getAlbums({ nullOnError: true, groupId: 'PhoneAlbums' });
    if (serverAlbums == null) throw new Error("Couldn't read the albums on your Lomorage computer.");
    const serverByName = new Map(serverAlbums.map(album => [album.name, album]));

    let added = 0;
    let albumCount = 0;
    for (const { title, ids: albumIds } of membership) {
      const hashes = [...new Set(albumIds.map(id => hashById.get(id)).filter(Boolean))];
      if (hashes.length === 0) continue;

      let serverAlbum = serverByName.get(title);
      let existing = new Set();
      if (serverAlbum) {
        existing = await RemoteAlbumService.getAllAlbumAssetHashes(serverAlbum.id);
      } else {
        serverAlbum = await RemoteAlbumService.createAlbum(title);
        if (!serverAlbum) throw new Error(`Couldn't create the album "${title}" on your Lomorage computer.`);
        serverByName.set(title, serverAlbum);
      }

      const toAdd = hashes.filter(hash => !existing.has(hash));
      for (let i = 0; i < toAdd.length; i += ADD_BATCH) {
        await RemoteAlbumService.addAssetsToAlbum(serverAlbum.id, toAdd.slice(i, i + ADD_BATCH));
      }
      added += toAdd.length;
      albumCount++;
    }
    console.log(`[PhoneAlbumService] Copied ${added} album entries into ${albumCount} server albums.`);
    return { albums: albumCount, added };
  }
}

export default new PhoneAlbumService();
