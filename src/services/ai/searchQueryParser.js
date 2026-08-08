// Extracts a relative or absolute date range (English or Chinese) from a free-text
// search query, e.g. "dog last week" -> { startTime, endTime, remainingText: "dog" }.
export function extractTimeRange(queryText) {
  if (!queryText) return { startTime: null, endTime: null, remainingText: '' };
  let text = queryText;
  let startTime = null;
  let endTime = null;
  const now = new Date();

  const startOfDay = (d) => {
    const nd = new Date(d);
    nd.setHours(0, 0, 0, 0);
    return nd.getTime();
  };
  const endOfDay = (d) => {
    const nd = new Date(d);
    nd.setHours(23, 59, 59, 999);
    return nd.getTime();
  };

  // 1. Check relative date terms (longest terms first to avoid partial matches)
  const relativePatterns = [
    { patterns: [/\blast week\b/i, /上周/g, /上星期/g], getRange: () => {
        const lastWeek = new Date();
        lastWeek.setDate(now.getDate() - 7);
        return { start: startOfDay(lastWeek), end: endOfDay(now) };
    }},
    { patterns: [/\blast month\b/i, /上个月/g], getRange: () => {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0).getTime();
        const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime();
        return { start, end };
    }},
    { patterns: [/\blast year\b/i, /去年/g], getRange: () => {
        const start = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0).getTime();
        const end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999).getTime();
        return { start, end };
    }},
    { patterns: [/\bthis year\b/i, /今年/g], getRange: () => {
        const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).getTime();
        return { start, end: endOfDay(now) };
    }},
    { patterns: [/\bthis month\b/i, /这个月/g], getRange: () => {
        const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
        return { start, end: endOfDay(now) };
    }},
    { patterns: [/\byesterday\b/i, /昨天/g], getRange: () => {
        const yesterday = new Date();
        yesterday.setDate(now.getDate() - 1);
        return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
    }},
    { patterns: [/\btoday\b/i, /今天/g], getRange: () => {
        return { start: startOfDay(now), end: endOfDay(now) };
    }}
  ];

  for (const item of relativePatterns) {
    for (const pat of item.patterns) {
      if (pat.test(text)) {
        const range = item.getRange();
        startTime = range.start;
        endTime = range.end;
        text = text.replace(pat, '');
        return { startTime, endTime, remainingText: text.trim() };
      }
    }
  }

  // 2. YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdPattern = /\b(\d{4})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/;
  const ymdMatch = text.match(ymdPattern);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10) - 1;
    const d = parseInt(ymdMatch[3], 10);
    const dateObj = new Date(y, m, d);
    startTime = startOfDay(dateObj);
    endTime = endOfDay(dateObj);
    text = text.replace(ymdPattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // Chinese YYYY年MM月DD日
  const ymdCnPattern = /(\d{4})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/;
  const ymdCnMatch = text.match(ymdCnPattern);
  if (ymdCnMatch) {
    const y = parseInt(ymdCnMatch[1], 10);
    const m = parseInt(ymdCnMatch[2], 10) - 1;
    const d = parseInt(ymdCnMatch[3], 10);
    const dateObj = new Date(y, m, d);
    startTime = startOfDay(dateObj);
    endTime = endOfDay(dateObj);
    text = text.replace(ymdCnPattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // 8-digit YYYYMMDD
  const ymd8Pattern = /\b(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/;
  const ymd8Match = text.match(ymd8Pattern);
  if (ymd8Match) {
    const y = parseInt(ymd8Match[1], 10);
    const m = parseInt(ymd8Match[2], 10) - 1;
    const d = parseInt(ymd8Match[3], 10);
    const dateObj = new Date(y, m, d);
    startTime = startOfDay(dateObj);
    endTime = endOfDay(dateObj);
    text = text.replace(ymd8Pattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // 3. YYYY-MM or YYYY/MM or YYYY.MM
  const ymPattern = /\b(\d{4})[-/.](0?[1-9]|1[0-2])\b/;
  const ymMatch = text.match(ymPattern);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10);
    const m = parseInt(ymMatch[2], 10) - 1;
    const start = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999).getTime();
    startTime = start;
    endTime = end;
    text = text.replace(ymPattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // Chinese YYYY年MM月
  const ymCnPattern = /(\d{4})年(0?[1-9]|1[0-2])月/;
  const ymCnMatch = text.match(ymCnPattern);
  if (ymCnMatch) {
    const y = parseInt(ymCnMatch[1], 10);
    const m = parseInt(ymCnMatch[2], 10) - 1;
    const start = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999).getTime();
    startTime = start;
    endTime = end;
    text = text.replace(ymCnPattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // 4. YYYY年
  const yCnPattern = /(\d{4})年/;
  const yCnMatch = text.match(yCnPattern);
  if (yCnMatch) {
    const y = parseInt(yCnMatch[1], 10);
    const start = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
    const end = new Date(y, 11, 31, 23, 59, 59, 999).getTime();
    startTime = start;
    endTime = end;
    text = text.replace(yCnPattern, '');
    return { startTime, endTime, remainingText: text.trim() };
  }

  // Numeric YYYY (restrict to reasonable years e.g. 1990 - 2100)
  const yPattern = /\b(\d{4})\b/;
  const yMatch = text.match(yPattern);
  if (yMatch) {
    const y = parseInt(yMatch[1], 10);
    if (y >= 1990 && y <= 2100) {
      const start = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
      const end = new Date(y, 11, 31, 23, 59, 59, 999).getTime();
      startTime = start;
      endTime = end;
      text = text.replace(yPattern, '');
      return { startTime, endTime, remainingText: text.trim() };
    }
  }

  return { startTime, endTime, remainingText: text.trim() };
}
