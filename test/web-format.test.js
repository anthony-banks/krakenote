// Unit tests for the web front-end formatters extracted from app.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, fmtShortDate, fmtNoteTime, ntMarkdown } from '../site/lib/format.js';

test('escapeHtml escapes HTML-significant characters', () => {
  assert.equal(escapeHtml('<b>a & "b" \'c\'>'), '&lt;b&gt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('fmtShortDate / fmtNoteTime handle empty + invalid input', () => {
  assert.equal(fmtShortDate(''), '');
  assert.equal(fmtShortDate('not-a-date'), '');
  assert.equal(fmtNoteTime(''), '');
  assert.equal(fmtNoteTime('nope'), '');
  // Valid dates return a non-empty string (exact text is locale/timezone dependent).
  assert.ok(fmtShortDate('2020-01-15T12:00:00Z').length > 0);
  assert.ok(fmtNoteTime('2020-06-15T12:00:00Z').length > 0);
});

test('ntMarkdown renders a safe subset and escapes before formatting', () => {
  assert.equal(ntMarkdown('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(ntMarkdown('# Heading'), '<h1>Heading</h1>');
  assert.equal(ntMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(ntMarkdown('`code`'), '<p><code>code</code></p>');
  assert.equal(ntMarkdown('[t](https://x.com)'),
    '<p><a href="https://x.com" target="_blank" rel="noopener">t</a></p>');
  // XSS: raw HTML is escaped before the markdown pass runs.
  assert.equal(ntMarkdown('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});
