// Marker embedded in family sign-in QR codes so the scanner can tell a real
// Lomorage pairing code apart from an unrelated QR code before touching
// the credentials inside it.
export const PAIRING_QR_TYPE = 'lomorage-pairing-v1';

// Marker embedded in the first-run setup QR code shown on a fresh lomod
// instance's own web page (before any account exists). Unlike
// PAIRING_QR_TYPE, this carries no credentials -- just enough to find the
// server -- since it's meant to be scanned before an account is created.
export const SETUP_QR_TYPE = 'lomorage-setup-v1';
