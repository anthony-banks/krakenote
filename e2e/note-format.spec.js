import { test, expect } from '@playwright/test';

// Round-trip + sanitizer fidelity for the note formatter (KRA-70, and proves the
// KRA-61 acceptance criteria). Loads the real /js/note-format.js the app ships and
// exercises it headlessly — no login or backend needed. If these fail, either a
// formatting feature stopped surviving save→reload, or the XSS boundary regressed.

test.beforeEach(async ({ page }) => {
  // /app.html loads /js/note-format.js, which defines the formatter as globals.
  await page.goto('/app.html');
  await page.waitForFunction(() => typeof window.ntSanitize === 'function');
});

// Helper: run ntSanitize in the page and return the resulting HTML.
const san = (page, html) => page.evaluate((h) => window.ntSanitize(h), html);
const toHtml = (page, stored) => page.evaluate((s) => window.ntBodyToHtml(s), stored);

test('canonical formatting survives sanitize unchanged in kind', async ({ page }) => {
  const cases = {
    bold: '<b>x</b>', strong: '<strong>x</strong>', italic: '<i>x</i>', em: '<em>x</em>',
    underline: '<u>x</u>', strike: '<s>x</s>', mark: '<mark>x</mark>',
    code: '<code>x</code>', pre: '<pre>x</pre>', quote: '<blockquote>x</blockquote>',
    h1: '<h1>x</h1>', h2: '<h2>x</h2>', h3: '<h3>x</h3>',
    ul: '<ul><li>x</li></ul>', ol: '<ol><li>x</li></ol>',
    link: '<a href="https://example.com">x</a>',
  };
  for (const [name, html] of Object.entries(cases)) {
    const out = await san(page, html);
    const tag = html.match(/^<([a-z0-9]+)/i)[1].toLowerCase();
    expect(out.toLowerCase(), `${name} should preserve its <${tag}>`).toContain('<' + tag);
    expect(out, `${name} should keep its text`).toContain('x');
  }
});

test('inline styles (color / highlight / weight / decoration) are preserved', async ({ page }) => {
  const out = await san(page,
    '<span style="color: rgb(255, 0, 0)">a</span>' +
    '<span style="background-color: rgb(255, 255, 0)">b</span>' +
    '<span style="font-weight: 700">c</span>' +
    '<span style="text-decoration: line-through">d</span>');
  expect(out).toContain('color:');
  expect(out).toContain('background-color:');
  expect(out).toContain('font-weight:');
  expect(out).toContain('line-through');
});

test('a link keeps a safe href but drops a javascript: URL', async ({ page }) => {
  const ok = await san(page, '<a href="https://example.com/x">link</a>');
  expect(ok).toContain('href="https://example.com/x"');
  const bad = await san(page, '<a href="javascript:alert(1)">link</a>');
  expect(bad.toLowerCase()).not.toContain('javascript:');
  expect(bad).toContain('link'); // text is kept, only the href is dropped
});

test('XSS payloads are neutralized', async ({ page }) => {
  const out = await san(page,
    '<script>alert(1)</script>' +
    '<img src=x onerror="alert(1)">' +
    '<p onclick="alert(1)" onmouseover="x()">hi</p>' +
    '<iframe src="https://evil.example"></iframe>');
  const low = out.toLowerCase();
  expect(low).not.toContain('<script');
  expect(low).not.toContain('<iframe');
  expect(low).not.toContain('<img');
  expect(low).not.toContain('onerror');
  expect(low).not.toContain('onclick');
  expect(low).not.toContain('onmouseover');
  expect(out).toContain('hi'); // legitimate text content survives
});

test('sanitize is idempotent (stable round-trip)', async ({ page }) => {
  const corpus = [
    '<h1>Title</h1><p><b>bold</b> and <i>italic</i></p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<p><span style="color: rgb(255, 0, 0)">red</span></p>',
    '<blockquote>quote</blockquote><pre>code block</pre>',
  ];
  for (const html of corpus) {
    const once = await san(page, html);
    const twice = await san(page, once);
    expect(twice, 'second pass must equal first').toBe(once);
  }
});

test('an empty/unstyled span is unwrapped, its text kept', async ({ page }) => {
  const out = await san(page, '<span>plain</span>');
  expect(out).not.toContain('<span');
  expect(out).toContain('plain');
});

// ── KRA-61 acceptance: legacy plain/markdown → HTML keeps structure + line breaks
test('legacy markdown renders headings, lists, and preserves blank lines (KRA-61)', async ({ page }) => {
  const out = await toHtml(page, '# Heading\n\nfirst paragraph\n\nsecond paragraph\n\n- a\n- b');
  expect(out).toContain('<h1>');
  expect(out).toContain('<ul>');
  expect(out.match(/<li>/g)?.length, 'both list items render').toBe(2);
  // Blank lines between paragraphs must not collapse.
  expect(out).toContain('<br>');
  expect(out).toContain('first paragraph');
  expect(out).toContain('second paragraph');
});

test('heading levels map correctly (# / ## / ###)', async ({ page }) => {
  const out = await toHtml(page, '# One\n## Two\n### Three');
  expect(out).toContain('<h1>');
  expect(out).toContain('<h2>');
  expect(out).toContain('<h3>');
});

test('an HTML body with a script is sanitized on load, not trusted', async ({ page }) => {
  const out = await toHtml(page, '<p>hello</p><script>alert(1)</script>');
  expect(out.toLowerCase()).not.toContain('<script');
  expect(out).toContain('hello');
});
