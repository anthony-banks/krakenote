import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, stripHtml, capText } from '../server/lib/text.js';

test('csvCell: plain values pass through unquoted', () => {
  assert.equal(csvCell('hello'), 'hello');
  assert.equal(csvCell('user@example.com'), 'user@example.com');
});

test('csvCell: quotes values containing comma, quote, CR or LF', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('has "quotes"'), '"has ""quotes"""'); // embedded quotes doubled
  assert.equal(csvCell('carriage\rreturn'), '"carriage\rreturn"');
});

test('csvCell: null/undefined → empty string', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('csvCell: neutralizes spreadsheet formula injection (KRA-145)', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tstart-tab'), "'\tstart-tab");
  // A dangerous value that also needs quoting gets both: prefix then RFC-4180 quote.
  assert.equal(csvCell('=HYPERLINK("http://x","a,b")'), '"\'=HYPERLINK(""http://x"",""a,b"")"');
  // Ordinary values are untouched (no false-positive prefixing).
  assert.equal(csvCell('user@example.com'), 'user@example.com'); // @ only triggers at start
  assert.equal(csvCell('hello'), 'hello');
  assert.equal(csvCell('3 - 2'), '3 - 2'); // leading digit, not an operator
});

test('stripHtml: removes tags and script/style bodies', () => {
  assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
  assert.equal(stripHtml('a<script>alert(1)</script>b'), 'a b');
  assert.equal(stripHtml('a<style>.x{color:red}</style>b'), 'a b');
});

test('stripHtml: decodes the entities we emit and collapses whitespace', () => {
  assert.equal(stripHtml('a&nbsp;&amp;&lt;&gt;&#39;&quot;b'), `a &<>'"b`);
  assert.equal(stripHtml('  spaced   \n  out  '), 'spaced out');
});

test('stripHtml: tolerates null/undefined', () => {
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
});

test('capText: short input is untouched, not truncated', () => {
  const r = capText('hello', 60000);
  assert.equal(r.clean, 'hello');
  assert.equal(r.charCount, 5);
  assert.equal(r.truncated, false);
});

test('capText: trims and reports the trimmed length', () => {
  const r = capText('  hi  ', 60000);
  assert.equal(r.clean, 'hi');
  assert.equal(r.charCount, 2);
});

test('capText: over-cap input is sliced and flagged truncated', () => {
  const r = capText('x'.repeat(100), 60);
  assert.equal(r.charCount, 60);
  assert.equal(r.truncated, true);
});

test('capText: input exactly at the cap is not flagged truncated', () => {
  const r = capText('y'.repeat(60), 60);
  assert.equal(r.charCount, 60);
  assert.equal(r.truncated, false);
});

test('capText: empty / null input yields empty clean, not truncated', () => {
  assert.deepEqual(capText('', 60), { clean: '', charCount: 0, truncated: false });
  assert.deepEqual(capText(null, 60), { clean: '', charCount: 0, truncated: false });
});
