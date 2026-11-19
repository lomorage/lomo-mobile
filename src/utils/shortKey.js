// A short, non-reversible key for a value such as an account id or token, for naming state kept
// per account without storing the value itself.
export function shortKey(value) {
  let h = 5381;
  const s = String(value || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
