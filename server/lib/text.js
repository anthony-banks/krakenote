// Small pure text helpers shared by index.js, extracted so they're unit-testable.

// Escape one CSV cell per RFC 4180: quote when the value contains a comma, quote,
// CR or LF, doubling any embedded quotes. Also neutralize spreadsheet formula
// injection (KRA-145): a value starting with = + - @ (or a tab/CR) is executed as
// a formula by Excel/Sheets/Numbers, so prefix it with a single quote to force it
// to render as literal text.
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Collapse HTML down to plain text: drop <script>/<style> bodies, strip all tags,
// decode the handful of entities we emit, and squeeze whitespace.
export function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Clamp extracted study material to a character cap (KRA-140). Returns the
// trimmed slice plus whether anything was dropped, so callers can surface a
// "we only used the first N characters" notice.
export function capText(raw, cap) {
  const full = raw || '';
  const clean = full.slice(0, cap).trim();
  return { clean, charCount: clean.length, truncated: full.length > cap };
}
