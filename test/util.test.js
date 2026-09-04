// Unit tests for the pure server helpers. Run with `npm test` (node:test, no deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtml, isYouTube, embeddedV4, ipIsPrivate, csvCell, isSuperuser,
} from '../server/lib/util.js';

test('stripHtml removes tags, scripts/styles, and decodes entities', () => {
  assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
  assert.equal(stripHtml('a<script>alert(1)</script>b'), 'a b');
  assert.equal(stripHtml('x<style>.a{}</style>y'), 'x y');
  assert.equal(stripHtml('Tom &amp; Jerry &lt;3 &quot;hi&quot;'), 'Tom & Jerry <3 "hi"');
  assert.equal(stripHtml('  lots\n\n of   space  '), 'lots of space');
  assert.equal(stripHtml(''), '');
});

test('isYouTube matches YouTube hosts only', () => {
  const yes = ['https://youtube.com/watch?v=x', 'https://www.youtube.com/x',
    'https://m.youtube.com/x', 'https://youtu.be/abc'];
  const no = ['https://example.com', 'https://notyoutube.com', 'https://youtube.com.evil.com'];
  for (const u of yes) assert.equal(isYouTube(new URL(u)), true, u);
  for (const u of no) assert.equal(isYouTube(new URL(u)), false, u);
});

test('embeddedV4 unwraps IPv4-in-IPv6 literals', () => {
  assert.equal(embeddedV4('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(embeddedV4('::1.2.3.4'), '1.2.3.4');
  assert.equal(embeddedV4('::ffff:a9fe:a9fe'), '169.254.169.254'); // hex form of metadata IP
  assert.equal(embeddedV4('::a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedV4('8.8.8.8'), '8.8.8.8'); // plain v4 unchanged
});

test('ipIsPrivate flags private/loopback/link-local/metadata (SSRF guard)', () => {
  const priv = ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'];
  const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1',
    '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  for (const ip of priv) assert.equal(ipIsPrivate(ip), true, `expected private: ${ip}`);
  for (const ip of pub) assert.equal(ipIsPrivate(ip), false, `expected public: ${ip}`);
  assert.equal(ipIsPrivate('not-an-ip'), true); // unparseable → unsafe
});

test('csvCell escapes per RFC 4180', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(42), '42');
});

test('isSuperuser checks the allowlist case-insensitively', () => {
  const allow = new Set(['admin@krakenote.com', 'boss@krakenote.com']);
  assert.equal(isSuperuser('admin@krakenote.com', allow), true);
  assert.equal(isSuperuser('ADMIN@Krakenote.com', allow), true);
  assert.equal(isSuperuser('nobody@krakenote.com', allow), false);
  assert.equal(isSuperuser(null, allow), false);
  assert.equal(isSuperuser(undefined, allow), false);
});
