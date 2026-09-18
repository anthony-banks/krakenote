import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipIsPrivate, embeddedV4 } from '../server/lib/net-guard.js';

// This is the SSRF boundary: anything ipIsPrivate() lets through is a host we'll
// actually fetch for an authenticated user, so a false "public" verdict on an
// internal address is a real vulnerability. These tests pin the classification.

test('blocks the cloud metadata IP and its IPv6-tunnelled forms', () => {
  assert.equal(ipIsPrivate('169.254.169.254'), true);          // link-local metadata
  assert.equal(ipIsPrivate('::ffff:169.254.169.254'), true);   // v4-mapped, dotted
  assert.equal(ipIsPrivate('::ffff:a9fe:a9fe'), true);         // v4-mapped, hex (WHATWG form)
  assert.equal(ipIsPrivate('::a9fe:a9fe'), true);              // v4-compatible, hex
});

test('blocks loopback (v4 + v6)', () => {
  assert.equal(ipIsPrivate('127.0.0.1'), true);
  assert.equal(ipIsPrivate('127.99.99.99'), true);
  assert.equal(ipIsPrivate('::1'), true);
  assert.equal(ipIsPrivate('::ffff:127.0.0.1'), true);
});

test('blocks RFC1918 private ranges', () => {
  assert.equal(ipIsPrivate('10.0.0.1'), true);
  assert.equal(ipIsPrivate('192.168.1.1'), true);
  assert.equal(ipIsPrivate('172.16.0.1'), true);   // low edge of 172.16/12
  assert.equal(ipIsPrivate('172.31.255.255'), true); // high edge
});

test('allows genuinely public 172.x outside 16–31', () => {
  assert.equal(ipIsPrivate('172.15.0.1'), false);
  assert.equal(ipIsPrivate('172.32.0.1'), false);
});

test('blocks 0.0.0.0/8, CGNAT, and IPv6 link-local / ULA', () => {
  assert.equal(ipIsPrivate('0.0.0.0'), true);
  assert.equal(ipIsPrivate('100.64.0.1'), true);   // CGNAT low edge
  assert.equal(ipIsPrivate('100.127.255.255'), true); // CGNAT high edge
  assert.equal(ipIsPrivate('fe80::1'), true);      // link-local
  assert.equal(ipIsPrivate('fc00::1'), true);      // ULA
  assert.equal(ipIsPrivate('fd12:3456::1'), true); // ULA
  assert.equal(ipIsPrivate('::'), true);           // unspecified
});

test('allows public addresses', () => {
  assert.equal(ipIsPrivate('8.8.8.8'), false);
  assert.equal(ipIsPrivate('1.1.1.1'), false);
  assert.equal(ipIsPrivate('99.63.255.254'), false); // just below CGNAT 100.64
  assert.equal(ipIsPrivate('2606:4700:4700::1111'), false); // public IPv6 (Cloudflare)
});

test('fails closed on anything unparseable', () => {
  assert.equal(ipIsPrivate('not-an-ip'), true);
  assert.equal(ipIsPrivate(''), true);
  assert.equal(ipIsPrivate('999.999.999.999'), true);
});

test('embeddedV4 unwraps tunnelled IPv4, passes everything else through', () => {
  assert.equal(embeddedV4('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(embeddedV4('::ffff:a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedV4('::a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedV4('8.8.8.8'), '8.8.8.8');            // plain v4 untouched
  assert.equal(embeddedV4('2606:4700::1111'), '2606:4700::1111'); // real v6 untouched
});
