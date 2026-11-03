// Sign in with Apple token revocation (App Store guideline 5.1.1(v)): when an
// Apple-linked account is deleted, the app sends a fresh authorization code;
// we exchange it for a refresh token and revoke that, which unlinks Krakenote
// from the user's Apple ID. Uses a .p8 key (APPLE_KEY_ID / APPLE_PRIVATE_KEY).
import crypto from 'node:crypto';

const APPLE = 'https://appleid.apple.com';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Apple's client_secret: an ES256 JWT signed with the .p8 key, valid <= 6 months.
export function makeClientSecret({ teamId, keyId, clientId, privateKey }, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: now, exp: now + 300, aud: APPLE, sub: clientId };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

// Env stores the key with literal "\n"s (single-line); restore real newlines.
export function normalizePrivateKey(raw) {
  return (raw || '').replace(/\\n/g, '\n').trim();
}

// Exchange the code, then revoke the refresh token (or the access token if no
// refresh token came back). Resolves { ok, error? }; never throws.
export async function revokeAppleAuthorization(code, cfg, fetchImpl = fetch) {
  try {
    const client_secret = makeClientSecret(cfg);
    const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
    const tokRes = await fetchImpl(`${APPLE}/auth/token`, form({ client_id: cfg.clientId, client_secret, code, grant_type: 'authorization_code' }));
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok) return { ok: false, error: 'token exchange failed: ' + (tok.error || tokRes.status) };
    const token = tok.refresh_token || tok.access_token;
    const hint = tok.refresh_token ? 'refresh_token' : 'access_token';
    if (!token) return { ok: false, error: 'no token returned' };
    const revRes = await fetchImpl(`${APPLE}/auth/revoke`, form({ client_id: cfg.clientId, client_secret, token, token_type_hint: hint }));
    if (!revRes.ok) return { ok: false, error: 'revoke failed: ' + revRes.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
