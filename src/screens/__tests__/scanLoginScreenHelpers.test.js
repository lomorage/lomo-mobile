import { classifyScannedQR } from '../scanLoginScreenHelpers';

describe('classifyScannedQR', () => {
    test('returns invalid for non-JSON data', () => {
        expect(classifyScannedQR('not json')).toEqual({ kind: 'invalid' });
    });

    test('returns invalid for JSON with an unrecognized type', () => {
        expect(classifyScannedQR(JSON.stringify({ type: 'something-else', server: 'host:8000' })))
            .toEqual({ kind: 'invalid' });
    });

    test('classifies a well-formed setup code', () => {
        const data = JSON.stringify({ type: 'lomorage-setup-v1', server: '192.168.1.10:8000', serverName: 'My Lomorage' });
        expect(classifyScannedQR(data)).toEqual({
            kind: 'setup',
            server: '192.168.1.10:8000',
            serverName: 'My Lomorage',
        });
    });

    test('setup code without serverName still classifies, with serverName null', () => {
        const data = JSON.stringify({ type: 'lomorage-setup-v1', server: '192.168.1.10:8000' });
        expect(classifyScannedQR(data)).toEqual({
            kind: 'setup',
            server: '192.168.1.10:8000',
            serverName: null,
        });
    });

    test('rejects a setup code with a non-string server', () => {
        const data = JSON.stringify({ type: 'lomorage-setup-v1', server: 12345 });
        expect(classifyScannedQR(data)).toEqual({ kind: 'invalid' });
    });

    test('rejects a setup code with a missing server', () => {
        const data = JSON.stringify({ type: 'lomorage-setup-v1' });
        expect(classifyScannedQR(data)).toEqual({ kind: 'invalid' });
    });

    test('classifies a well-formed pairing code', () => {
        const data = JSON.stringify({
            type: 'lomorage-pairing-v1',
            server: '192.168.1.10:8000',
            username: 'alice',
            password: 'secret123',
            serverName: 'My Lomorage',
        });
        expect(classifyScannedQR(data)).toEqual({
            kind: 'pairing',
            server: '192.168.1.10:8000',
            username: 'alice',
            password: 'secret123',
            serverName: 'My Lomorage',
        });
    });

    test('rejects a pairing code missing a password', () => {
        const data = JSON.stringify({ type: 'lomorage-pairing-v1', server: '192.168.1.10:8000', username: 'alice' });
        expect(classifyScannedQR(data)).toEqual({ kind: 'invalid' });
    });

    test('rejects a pairing code with a non-string username', () => {
        const data = JSON.stringify({
            type: 'lomorage-pairing-v1',
            server: '192.168.1.10:8000',
            username: 42,
            password: 'secret123',
        });
        expect(classifyScannedQR(data)).toEqual({ kind: 'invalid' });
    });
});
