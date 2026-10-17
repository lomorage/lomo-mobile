// Whether text typed into a "Server Address" field is a complete host[:port], so it is worth
// contacting. While someone types "10.0.0.219:8000", the field passes through "10.0.0.2",
// "10.0.0.219:" and "10.0.0.219:8"; none of those should hit the network.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isCompleteServerAddress(text) {
  if (!text) return false;
  const address = text.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const portAt = address.lastIndexOf(':');
  let host = address;
  if (portAt !== -1) {
    const port = address.slice(portAt + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
    host = address.slice(0, portAt);
  }
  if (IPV4.test(host)) return true;
  // A dotted number that isn't a full IPv4 yet ("10.0.0") is not a hostname either.
  if (/^[\d.]+$/.test(host)) return false;
  return HOSTNAME.test(host);
}
