// A 400 from lomod is not a "retry later". Most of lomod's own errors map to 400, transient
// ones among them, so only the answers that describe the file itself may be treated as final.
// Getting this wrong in either direction is costly: too eager skips good photos over a passing
// server-side failure, too shy is what let one AVIF file be re-sent 3070 times in 2h50m while
// nothing else got uploaded.
jest.mock('axios');
jest.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///mock-cache/',
    makeDirectoryAsync: jest.fn(async () => {}),
    deleteAsync: jest.fn(async () => {}),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../MediaService', () => ({}));
jest.mock('../AuthService', () => ({ getServerUrl: jest.fn(), getToken: jest.fn() }));
jest.mock('../../../modules/expo-lomo-hasher', () => ({ sliceFileAsync: jest.fn(), sliceFileRangeAsync: jest.fn() }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn() }));

import { isPermanentReject, PERMANENT_REJECT_TEXTS } from '../UploadService';

describe('isPermanentReject', () => {
    test('an extension lomod has no handler for is final (the AVIF case)', () => {
        expect(isPermanentReject(400, 'Not implemented: extension: avif')).toBe(true);
    });

    test('an empty body is retryable: it describes that request, not the file', () => {
        // lomod raises these when zero bytes arrived in that one request. A local file briefly
        // unreadable (an iCloud placeholder, a file being written) refuses now and uploads fine
        // next time, so skipping it for good would lose a photo that was never unusable.
        expect(isPermanentReject(400, 'Empty asset')).toBe(false);
        expect(isPermanentReject(400, 'create asset abc123: empty size')).toBe(false);
    });

    test('a missing date is retryable: the next request carries one', () => {
        // validateAsset decides this from the createtime/modifiedtime query params, and
        // buildUploadUrl derives those from MediaAsset.exifTakenTime -- NULL until the EXIF read
        // fills it in. Same bytes, different request, different answer.
        expect(isPermanentReject(400, 'validate asset time abc: No create time')).toBe(false);
        expect(isPermanentReject(400, 'No timestamp')).toBe(false);
    });

    test('lomod 400s that are really server-side failures stay retryable', () => {
        // common/errors.go maps all of these to 400 as well.
        expect(isPermanentReject(400, 'Fail to update')).toBe(false);
        expect(isPermanentReject(400, 'API can only be visited internally')).toBe(false);
        expect(isPermanentReject(400, 'Unknown Error')).toBe(false);
        expect(isPermanentReject(400, 'Bad Request')).toBe(false);
    });

    test('a stale token must never mark the photo itself unacceptable', () => {
        // Otherwise one expired token walks the whole library into the skipped pile.
        expect(isPermanentReject(401, 'Invalid Token')).toBe(false);
        expect(isPermanentReject(403, 'Invalid Token')).toBe(false);
    });

    test('rate limiting, duplicates and too-large bodies keep their own handling', () => {
        expect(isPermanentReject(429, 'Too many preview requests, try again shortly')).toBe(false);
        expect(isPermanentReject(409, 'Requested resource Exist')).toBe(false);
        expect(isPermanentReject(413, '')).toBe(false);
        expect(isPermanentReject(408, '')).toBe(false);
    });

    test('a hash mismatch is re-hashed and re-queued, not skipped', () => {
        expect(isPermanentReject(400, 'Uploaded asset has different hash')).toBe(false);
    });

    test('server errors and successes are not refusals', () => {
        expect(isPermanentReject(500, 'Not implemented')).toBe(false);
        expect(isPermanentReject(503, 'Service is in maintenance mode')).toBe(false);
        expect(isPermanentReject(200, '')).toBe(false);
        expect(isPermanentReject(undefined, 'Not implemented')).toBe(false);
    });

    test('an unrecognised 400 is retryable: only a known wording is final', () => {
        expect(isPermanentReject(400, 'something nobody has seen before')).toBe(false);
        expect(isPermanentReject(400, '')).toBe(false);
    });

    test('the allowlist stays minimal, because a wrong entry loses a photo silently', () => {
        // A guard on the list itself: every entry has to be a property of the file and of this
        // server's capabilities, never of the client's request or of what reached the wire.
        // Adding one is a deliberate act, so make it a visible change here too.
        expect(PERMANENT_REJECT_TEXTS).toEqual(['Not implemented']);
    });
});
