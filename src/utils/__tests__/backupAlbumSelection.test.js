import { applyAlbumInclusion, filterAlbums, sortAlbums } from '../backupAlbumSelection';

const albums = [
  { id: 'cam', title: 'Camera', assetCount: 100 },
  { id: 'ss', title: 'Screenshots', assetCount: 40 },
  { id: 'wa', title: 'WhatsApp', assetCount: 40 },
  { id: 'dl', title: 'Downloads', assetCount: 2 },
];

describe('filterAlbums', () => {
  test('blank query keeps every album', () => {
    expect(filterAlbums(albums, '  ')).toEqual(albums);
  });

  test('matches the title, ignoring case', () => {
    expect(filterAlbums(albums, 'shot').map((a) => a.id)).toEqual(['ss']);
  });
});

describe('sortAlbums', () => {
  test('most photos first, then name when the counts match', () => {
    expect(sortAlbums(albums, 'countDesc').map((a) => a.id)).toEqual(['cam', 'ss', 'wa', 'dl']);
  });

  test('fewest photos first', () => {
    expect(sortAlbums(albums, 'countAsc').map((a) => a.id)).toEqual(['dl', 'ss', 'wa', 'cam']);
  });

  test('name sort is alphabetical', () => {
    expect(sortAlbums(albums, 'name').map((a) => a.id)).toEqual(['cam', 'dl', 'ss', 'wa']);
  });
});

describe('applyAlbumInclusion', () => {
  test('skip these adds only the albums on screen', () => {
    expect(applyAlbumInclusion(['dl'], ['ss', 'wa'], false)).toEqual(['dl', 'ss', 'wa']);
  });

  test('back up these removes only the albums on screen', () => {
    expect(applyAlbumInclusion(['cam', 'ss', 'wa'], ['ss'], true)).toEqual(['cam', 'wa']);
  });

  test('skip all is every album when the screen is unfiltered', () => {
    expect(applyAlbumInclusion([], albums.map((a) => a.id), false)).toEqual(['cam', 'ss', 'wa', 'dl']);
  });

  test('back up all clears the skip list when the screen is unfiltered', () => {
    expect(applyAlbumInclusion(['cam', 'ss'], albums.map((a) => a.id), true)).toEqual([]);
  });
});
