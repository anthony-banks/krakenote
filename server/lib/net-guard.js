import net from 'node:net';

// ── SSRF guard helpers for user-supplied URL ingestion ──────────────────────
// An authenticated user hands us a URL and we fetch it, so without this a request
// could target the cloud metadata endpoint (169.254.169.254), localhost, or any
// internal host and read the response back inside generated cards.
//
// An IPv4 tunnelled inside IPv6 (::ffff:1.2.3.4, or its hex form ::ffff:a9fe:a9fe
// that WHATWG URL normalizes to, and IPv4-compatible ::a9fe:a9fe) must be judged by
// its embedded IPv4, or the metadata/loopback IPs sail through the v6 checks. Returns
// the dotted IPv4 when one is embedded, else the input unchanged.
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

// True if `ip` is private / loopback / link-local / ULA / CGNAT / metadata, or
// unparseable (fail-closed). Callers must treat `true` as "do not fetch".
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
