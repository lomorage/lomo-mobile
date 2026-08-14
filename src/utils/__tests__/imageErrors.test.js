import { isNotFoundImageError } from '../imageErrors';

describe('isNotFoundImageError', () => {
    test('detects the Glide/OkHttp 404 message format', () => {
        expect(isNotFoundImageError('com.bumptech.glide.load.HttpException: Not Found, status code: 404')).toBe(true);
    });

    test('returns false for a timeout/transient error', () => {
        expect(isNotFoundImageError('java.net.SocketTimeoutException: timeout')).toBe(false);
    });

    test('returns false for other HTTP error codes', () => {
        expect(isNotFoundImageError('HttpException: Internal Server Error, status code: 500')).toBe(false);
        expect(isNotFoundImageError('HttpException: Forbidden, status code: 403')).toBe(false);
    });

    test('returns false for null/undefined/empty input', () => {
        expect(isNotFoundImageError(null)).toBe(false);
        expect(isNotFoundImageError(undefined)).toBe(false);
        expect(isNotFoundImageError('')).toBe(false);
    });
});
