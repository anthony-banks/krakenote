import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeClientSecret, normalizePrivateKey, revokeAppleAuthorization } from '../server/lib/apple-revoke.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const cfg = { teamId: 'TEAM123456', keyId: 'KEY1234567', clientId: 'com.krakenote.mobile', privateKey: pem };

test('makeClientSecret: ES256 JWT Apple accepts (claims + verifiable signature)', () => {
  const jwt = makeClientSecret(cfg, 1000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')),
    { iss: 'TEAM123456', iat: 1000, exp: 1300, aud: 'https://appleid.apple.com', sub: 'com.krakenote.mobile' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('normalizePrivateKey: restores newlines from a single-line env value', () => {
  assert.equal(normalizePrivateKey('-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n'),
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
});

const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('revokeAppleAuthorization: exchanges the code, then revokes the refresh token', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return url.endsWith('/auth/token') ? res(200, { refresh_token: 'r1', access_token: 'a1' }) : res(200, {});
  };
  assert.deepEqual(await revokeAppleAuthorization('code1', cfg, fake), { ok: true });
  assert.equal(calls[0].url, 'https://appleid.apple.com/auth/token');
  assert.equal(calls[0].body.code, 'code1');
  assert.equal(calls[0].body.grant_type, 'authorization_code');
  assert.equal(calls[1].url, 'https://appleid.apple.com/auth/revoke');
  assert.equal(calls[1].body.token, 'r1');
  assert.equal(calls[1].body.token_type_hint, 'refresh_token');
});

test('revokeAppleAuthorization: reports (does not throw) on a bad code', async () => {
  const out = await revokeAppleAuthorization('bad', cfg, async () => res(400, { error: 'invalid_grant' }));
  assert.deepEqual(out, { ok: false, error: 'token exchange failed: invalid_grant' });
});
