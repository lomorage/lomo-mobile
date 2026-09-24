import { parseSetupLink } from '../screens/scanLoginScreenHelpers';

// Decides what to do with a URL the OS opened the app with (see useSetupLinks
// in RootNavigator). Kept free of React/native calls so it can be unit tested.
//   - 'ignore': not a setup link, or a stale redelivery (below).
//   - 'signed-in': a setup link while already signed in. Setup codes are for
//     creating the first account on a fresh server; following one here would
//     register on that server and silently replace the current session.
//   - 'prompt': confirm the server, then start account setup on it.
//
// Android redelivers the launching intent when the app is reopened from
// Recents after its process died, so the same initial URL can come back days
// later. A signed-in user would get the 'signed-in' alert on every such
// launch, so a repeat of the last initial URL is ignored for them. Signed-out
// users still get the prompt: re-scanning the same code after cancelling is a
// real request, and a stray prompt only costs them a tap on Cancel.
export const setupLinkAction = (url, { isAuthenticated, isInitial = false, lastInitialUrl = null }) => {
    const result = parseSetupLink(url);
    if (!result) return { type: 'ignore' };
    if (isAuthenticated) {
        if (isInitial && url === lastInitialUrl) return { type: 'ignore' };
        return { type: 'signed-in', result };
    }
    return { type: 'prompt', result };
};
