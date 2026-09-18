import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedback, buildLinearIssue } from '../server/lib/feedback.js';

test('normalizeFeedback: valid idea passes through, defaults kind to idea', () => {
  assert.deepEqual(normalizeFeedback({ message: 'Add dark mode' }),
    { ok: true, kind: 'idea', message: 'Add dark mode', page: null });
});

test('normalizeFeedback: only exact "bug" is a bug; anything else is an idea', () => {
  assert.equal(normalizeFeedback({ kind: 'bug', message: 'It crashes' }).kind, 'bug');
  assert.equal(normalizeFeedback({ kind: 'BUG', message: 'x x' }).kind, 'idea');
  assert.equal(normalizeFeedback({ kind: 'feature', message: 'x x' }).kind, 'idea');
  assert.equal(normalizeFeedback({ message: 'x x' }).kind, 'idea');
});

test('normalizeFeedback: trims message and keeps optional page', () => {
  const r = normalizeFeedback({ message: '  hello there  ', page: '  /app/account  ' });
  assert.equal(r.message, 'hello there');
  assert.equal(r.page, '/app/account');
});

test('normalizeFeedback: rejects too-short / empty / whitespace-only messages', () => {
  assert.equal(normalizeFeedback({ message: '' }).ok, false);
  assert.equal(normalizeFeedback({ message: 'a' }).ok, false);
  assert.equal(normalizeFeedback({ message: '   ' }).ok, false);
  assert.equal(normalizeFeedback({}).ok, false);
  assert.equal(normalizeFeedback(null).ok, false);
  assert.equal(normalizeFeedback({ message: 'x' }).error, 'Please add a little more detail.');
});

test('normalizeFeedback: caps message at 4000 and page at 200 chars', () => {
  const r = normalizeFeedback({ message: 'x'.repeat(5000), page: 'p'.repeat(500) });
  assert.equal(r.message.length, 4000);
  assert.equal(r.page.length, 200);
});

test('normalizeFeedback: coerces non-string message safely', () => {
  const r = normalizeFeedback({ message: 12345 });
  assert.equal(r.ok, true);
  assert.equal(r.message, '12345');
});

test('normalizeFeedback: empty page collapses to null, not ""', () => {
  assert.equal(normalizeFeedback({ message: 'hello', page: '   ' }).page, null);
});

test('buildLinearIssue: tags title by kind and clips to one line', () => {
  const bug = buildLinearIssue({ kind: 'bug', message: 'Login button does nothing' });
  assert.ok(bug.title.startsWith('[Bug] '));
  const idea = buildLinearIssue({ kind: 'idea', message: 'Add a widget' });
  assert.ok(idea.title.startsWith('[Idea] '));
});

test('buildLinearIssue: long multi-line message → title is a short single line', () => {
  const { title } = buildLinearIssue({ kind: 'bug', message: 'line one\nline two\n' + 'z'.repeat(200) });
  assert.ok(!title.includes('\n'), 'title must be single-line');
  // '[Bug] ' (6) + up to 80 chars of the message
  assert.ok(title.length <= 6 + 80, `title too long: ${title.length}`);
});

test('buildLinearIssue: description carries full message + provenance', () => {
  const { description } = buildLinearIssue({
    kind: 'bug', message: 'It crashes on save', email: 'user@example.com', page: '/app/notes',
  });
  assert.ok(description.includes('It crashes on save'));
  assert.ok(description.includes('- Reporter: user@example.com'));
  assert.ok(description.includes('- Page: /app/notes'));
  assert.ok(description.includes('_From in-app feedback_'));
});

test('buildLinearIssue: omits reporter/page lines when absent', () => {
  const { description } = buildLinearIssue({ kind: 'idea', message: 'Nice to have' });
  assert.ok(!description.includes('Reporter:'));
  assert.ok(!description.includes('Page:'));
});
