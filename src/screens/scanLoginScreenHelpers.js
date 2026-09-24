import { PAIRING_QR_TYPE, SETUP_QR_TYPE } from '../constants/pairing';

// Classifies a scanned QR code's raw string payload into one of Lomorage's
// known code types, or 'invalid' if it isn't recognized -- wrong JSON, wrong
// `type`, or a field with the wrong JS type (e.g. a crafted/garbled code
// with a non-string `server`, which would otherwise reach AuthService's
// formatServerUrl() and throw on `address.startsWith`).
const asString = (v) => (typeof v === 'string' && v ? v : null);

// Setup codes from newer servers are a lomorage.com link instead of JSON, so
// a phone without the app installed lands on a page that tells the user to
// install it (see lomo-backend handler/setup.go and the homepage's /s/ page).
// The parameters ride in the fragment so the web host never sees the LAN
// address. Parsed by hand: React Native's URL polyfill lacks `hash` and
// URLSearchParams.get.
const SETUP_LINK = /^https?:\/\/(?:www\.)?lomorage\.com\/s\/?(?:\?[^#]*)?#(.*)$/i;

export const parseSetupLink = (url) => {
    const match = typeof url === 'string' ? url.trim().match(SETUP_LINK) : null;
    if (!match) return null;

    // No prototype, so a crafted key like __proto__ is just another entry.
    const params = Object.create(null);
    for (const part of match[1].split('&')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        try {
            const decode = (v) => decodeURIComponent(v.replace(/\+/g, ' '));
            params[decode(part.slice(0, eq))] = decode(part.slice(eq + 1));
        } catch {
            return null;
        }
    }

    const server = asString(params.server);
    if (!server) return null;
    return { kind: 'setup', server, serverName: asString(params.name) };
};

export const classifyScannedQR = (data) => {
    const link = parseSetupLink(data);
    if (link) return link;

    let payload;
    try {
        payload = JSON.parse(data);
    } catch {
        return { kind: 'invalid' };
    }

    const serverName = asString(payload?.serverName);

    if (payload?.type === SETUP_QR_TYPE) {
        const server = asString(payload.server);
        if (server) {
            return { kind: 'setup', server, serverName };
        }
    }

    if (payload?.type === PAIRING_QR_TYPE) {
        const server = asString(payload.server);
        const username = asString(payload.username);
        const password = asString(payload.password);
        if (server && username && password) {
            return { kind: 'pairing', server, username, password, serverName };
        }
    }

    return { kind: 'invalid' };
};
