// Pure, dependency-light helpers extracted from server/index.js so they can be
// unit-tested without booting the HTTP server. Keep everything here free of
// Express, env, and I/O side effects — just data in, data out.
import net from 'node:net';

// Strip tags + decode a handful of entities from HTML, collapsing whitespace.
export function stripHtml(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// True when a WHATWG URL points at YouTube.
export function isYouTube(u) {
  return /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be' || u.hostname === 'm.youtube.com';
}

// Unwrap an IPv4-mapped/compatible IPv6 literal (::ffff:1.2.3.4, ::ffff:a9fe:a9fe,
// ::a9fe:a9fe) to its dotted IPv4 so the v4 checks can judge it; else return input.
export function embeddedV4(s) {
  const dotted = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return s;
}

// SSRF guard: is this IP private/loopback/link-local/ULA/CGNAT/metadata? An
// unparseable value is treated as unsafe (true).
export function ipIsPrivate(ip) {
  ip = embeddedV4(ip.toLowerCase()); // unwrap IPv4-mapped/compatible IPv6 to its v4
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;        // private / loopback / this-network
    if (a === 169 && b === 254) return true;                  // link-local incl. metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;         // private
    if (a === 192 && b === 168) return true;                  // private
    if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;           // loopback / unspecified
    if (low.startsWith('fe80')) return true;                  // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local fc00::/7
    return false;
  }
  return true; // unparseable → treat as unsafe
}

// Escape a single CSV cell per RFC 4180.
export function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// True when email is in the provided allowlist Set (case-insensitive).
export function isSuperuser(email, allowlist) {
  return typeof email === 'string' && allowlist.has(email.toLowerCase());
}
