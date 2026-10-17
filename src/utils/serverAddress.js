// Whether text typed into a "Server Address" field is a complete host[:port], so it is worth
// contacting. While someone types "10.0.0.219:8000", the field passes through "10.0.0.2",
// "10.0.0.219:" and "10.0.0.219:8"; none of those should hit the network.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// Eight groups of hex, with at most one "::" standing in for a run of zeroes, an optional
// "%eth0" zone on a link-local address, and the IPv4-tailed forms ("::ffff:10.0.0.1").
const IPV6 = /^(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)|(?:[0-9A-Fa-f]{1,4}:){1,6}(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)|(?:[0-9A-Fa-f]{1,4}:){1,5}:(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)|::(?:[0-9A-Fa-f]{1,4}:){0,5}(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))(?:%[0-9A-Za-z._~-]+)?$/;

function isPort(port) {
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

export function isCompleteServerAddress(text) {
  if (!text) return false;
  const address = text.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!address) return false;

  // Bracketed IPv6 ("[2001:db8::1]", "[2001:db8::1]:8000"): the brackets are what separate the
  // colons inside the address from the one before the port.
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    if (close === -1) return false; // the closing bracket is still being typed
    const rest = address.slice(close + 1);
    if (rest !== '' && !(rest.startsWith(':') && isPort(rest.slice(1)))) return false;
    return IPV6.test(address.slice(1, close));
  }

  // A bare IPv6 address carries no port: in "fd00::1:8000" the 8000 is part of the address,
  // which is why a port needs the bracketed form above.
  if (IPV6.test(address)) return true;

  const portAt = address.lastIndexOf(':');
  let host = address;
  if (portAt !== -1) {
    if (!isPort(address.slice(portAt + 1))) return false;
    host = address.slice(0, portAt);
  }
  if (IPV4.test(host)) return true;
  // A dotted number that isn't a full IPv4 yet ("10.0.0") is not a hostname either.
  if (/^[\d.]+$/.test(host)) return false;
  return HOSTNAME.test(host);
}
