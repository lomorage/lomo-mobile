// One answer to "when was this photo taken?", used for the upload date, the local hash tree and
// the timeline, so they agree with each other and with what lomod files the photo under.
//
// Android leaves DATE_TAKEN empty when a photo's EXIF date has no time zone (copied from older
// cameras, a PC or chat apps), and expo then reports creationTime 0. The EXIF date is still in
// the file; it's wall-clock time where the photo was taken, so it's read as local time here.

// "YYYY:MM:DD HH:MM:SS" (EXIF) -> ms since epoch in local time, or null.
export function parseExifDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const time = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(time) ? time : null;
}

// The taken time in an expo-media-library `exif` object (Android: flat tags; iOS: under {Exif}).
export function exifTakenTime(exif) {
  if (!exif || typeof exif !== 'object') return null;
  const sources = [exif['{Exif}'], exif].filter(Boolean);
  for (const tag of ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime']) {
    for (const source of sources) {
      const time = parseExifDateTime(source[tag]);
      if (time) return time;
    }
  }
  return null;
}

// creationTime when the OS knows it, else the EXIF date, else the file's modification time.
export function resolveTakenTime({ creationTime, modificationTime, exif } = {}, exifTime = null) {
  if (creationTime > 0) return creationTime;
  const fromExif = exifTime || exifTakenTime(exif);
  if (fromExif) return fromExif;
  return modificationTime > 0 ? modificationTime : null;
}
