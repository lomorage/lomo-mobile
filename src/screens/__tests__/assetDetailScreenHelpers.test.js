import { getCacheKey } from '../assetDetailScreenHelpers';

describe('getCacheKey', () => {
  test('uses the hash directly for a remote asset', () => {
    expect(getCacheKey({ status: 'remote', hash: 'abc123', id: 'ignored' })).toBe('abc123');
  });

  test('sanitizes non-alphanumeric characters out of the id for local/synced assets', () => {
    expect(getCacheKey({ status: 'local', id: 'ABCD-1234/EFGH_5678' })).toBe('ABCD1234EFGH5678');
  });

  test('returns an empty string when a local/synced asset has no id', () => {
    expect(getCacheKey({ status: 'synced', id: null })).toBe('');
    expect(getCacheKey({ status: 'local' })).toBe('');
  });
});

describe('formatTakenDate', () => {
    const { formatTakenDate } = require('../assetDetailScreenHelpers');

    it('uses the taken time when known', () => {
        const ms = new Date(2024, 6, 4, 15, 30).getTime();
        expect(formatTakenDate({ creationTime: ms })).toBe(new Date(ms).toLocaleString());
    });

    it('falls back to the modification time, in seconds or ms', () => {
        const ms = new Date(2024, 6, 4, 15, 30).getTime();
        expect(formatTakenDate({ creationTime: 0, modificationTime: ms })).toBe(new Date(ms).toLocaleString());
        expect(formatTakenDate({ creationTime: 0, modificationTime: ms / 1000 })).toBe(new Date(ms).toLocaleString());
    });

    it('shows nothing rather than 1970 when no date is known', () => {
        expect(formatTakenDate({ creationTime: 0 })).toBe('');
        expect(formatTakenDate({})).toBe('');
        expect(formatTakenDate(undefined)).toBe('');
    });
});

describe('formatTakenDate units', () => {
    const { formatTakenDate } = require('../assetDetailScreenHelpers');

    it('reads a creationTime in seconds as well as milliseconds', () => {
        const ms = new Date(2024, 6, 4, 15, 30).getTime();
        expect(formatTakenDate({ creationTime: ms / 1000 })).toBe(new Date(ms).toLocaleString());
    });
});

describe('contentAspectOf', () => {
    const { contentAspectOf } = require('../assetDetailScreenHelpers');

    it('prefers the size the image view reported after loading', () => {
        expect(contentAspectOf({ mediaType: 'photo', width: 2000, height: 1500 }, { w: 1500, h: 2000 })).toBeCloseTo(0.75);
    });

    it('falls back to the library size, and to unknown', () => {
        expect(contentAspectOf({ mediaType: 'photo', width: 2000, height: 1000 }, undefined)).toBe(2);
        expect(contentAspectOf({ mediaType: 'photo' }, undefined)).toBeUndefined();
    });

    it('does not guess for videos (rotated sizes, the player letterboxes itself)', () => {
        expect(contentAspectOf({ mediaType: 'video', width: 1920, height: 1080 }, { w: 640, h: 360 })).toBeUndefined();
    });
});

describe('mergeServerMetadata', () => {
    const { mergeServerMetadata } = require('../assetDetailScreenHelpers');
    // What lomod really sends for GET /asset/metadata/<hash> (Go struct types.Asset: capitalised keys).
    const server = { Name: '20240704_153000.mp4', Hash: 'abc', Date: '2024-07-04 15:30:00', Status: 0 };

    it('fills name, date and the video type of an album item the phone has no details for', () => {
        const merged = mergeServerMetadata(
            { id: 'abc', hash: 'abc', mediaType: 'image', creationTime: 0, filename: '', isMetadataPartial: true },
            server,
        );
        expect(merged.filename).toBe('20240704_153000.mp4');
        expect(merged.creationTime).toBe(Date.UTC(2024, 6, 4, 15, 30, 0));
        expect(merged.mediaType).toBe('video');
        expect(merged.isMetadataPartial).toBe(false);
    });

    it('keeps what the item already knows', () => {
        const taken = new Date(2024, 6, 4, 9, 0).getTime();
        const merged = mergeServerMetadata(
            { id: 'x', mediaType: 'photo', creationTime: taken, filename: 'PXL_1.jpg', isMetadataPartial: true },
            { Name: '20240704_7.jpg', Date: '2020-01-01 00:00:00' },
        );
        expect(merged).toMatchObject({ filename: 'PXL_1.jpg', creationTime: taken, mediaType: 'photo', isMetadataPartial: false });
    });

    it('survives an empty or unexpected answer', () => {
        const merged = mergeServerMetadata({ id: 'x', mediaType: 'image', creationTime: 0, isMetadataPartial: true }, {});
        expect(merged).toMatchObject({ filename: '', creationTime: 0, mediaType: 'image', isMetadataPartial: false });
    });
});
