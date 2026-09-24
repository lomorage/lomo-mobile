import { setupLinkAction } from '../setupLinkHelpers';

const LINK = 'https://lomorage.com/s/#server=192.168.1.10:8000&name=Home';
const RESULT = { kind: 'setup', server: '192.168.1.10:8000', serverName: 'Home' };

describe('setupLinkAction', () => {
    test('ignores URLs that are not setup links', () => {
        expect(setupLinkAction('https://lomorage.com/blog/', { isAuthenticated: false })).toEqual({ type: 'ignore' });
        expect(setupLinkAction(null, { isAuthenticated: false, isInitial: true })).toEqual({ type: 'ignore' });
    });

    test('prompts a signed-out user, even for a repeat of the last launch link', () => {
        expect(setupLinkAction(LINK, { isAuthenticated: false })).toEqual({ type: 'prompt', result: RESULT });
        expect(setupLinkAction(LINK, { isAuthenticated: false, isInitial: true, lastInitialUrl: LINK }))
            .toEqual({ type: 'prompt', result: RESULT });
    });

    test('never starts account setup for a signed-in user', () => {
        expect(setupLinkAction(LINK, { isAuthenticated: true })).toEqual({ type: 'signed-in', result: RESULT });
        expect(setupLinkAction(LINK, { isAuthenticated: true, isInitial: true, lastInitialUrl: 'https://lomorage.com/s/#server=other:8000' }))
            .toEqual({ type: 'signed-in', result: RESULT });
    });

    test('ignores a redelivered launch link for a signed-in user', () => {
        expect(setupLinkAction(LINK, { isAuthenticated: true, isInitial: true, lastInitialUrl: LINK })).toEqual({ type: 'ignore' });
        // The same link arriving while the app runs is a fresh scan, not a redelivery.
        expect(setupLinkAction(LINK, { isAuthenticated: true, isInitial: false, lastInitialUrl: LINK }))
            .toEqual({ type: 'signed-in', result: RESULT });
    });
});
