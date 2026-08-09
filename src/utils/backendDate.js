// Parses a date string from the lomorage backend and ensures it's treated as UTC.
// Backend dates (e.g. "2024-03-16 08:23:26") often lack a timezone suffix; JS's
// Date constructor treats such "naive" strings as local time, which silently
// shifts every timestamp by the device's UTC offset. Returns null for
// unparseable input.
export function parseBackendDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;

  let normalized = dateStr.trim();
  // Check if it already has UTC indicator (Z) or an offset (+HH:mm or -HH:mm at the end)
  // We avoid a simple .includes('-') because date separators use dashes.
  const hasTimeZone = /Z$|[+-]\d{2}(?::?\d{2})?$/.test(normalized);

  if (!hasTimeZone) {
    // Replace space with T for valid ISO format if needed and force UTC
    normalized = normalized.replace(' ', 'T') + 'Z';
  }

  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}
