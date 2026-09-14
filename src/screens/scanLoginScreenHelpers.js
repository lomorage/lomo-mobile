import { PAIRING_QR_TYPE, SETUP_QR_TYPE } from '../constants/pairing';

// Classifies a scanned QR code's raw string payload into one of Lomorage's
// known code types, or 'invalid' if it isn't recognized -- wrong JSON, wrong
// `type`, or a field with the wrong JS type (e.g. a crafted/garbled code
// with a non-string `server`, which would otherwise reach AuthService's
// formatServerUrl() and throw on `address.startsWith`).
export const classifyScannedQR = (data) => {
    let payload;
    try {
        payload = JSON.parse(data);
    } catch {
        return { kind: 'invalid' };
    }

    const asString = (v) => (typeof v === 'string' && v ? v : null);
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
