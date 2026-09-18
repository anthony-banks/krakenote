// Pure helpers for the in-app feedback feature — kept out of index.js so they
// can be unit-tested without booting Express or touching the network/DB.

// Normalize an untrusted feedback submission body into a stored row shape, or an
// error. `kind` collapses to 'idea' unless it's exactly 'bug'; message is trimmed
// and capped; page is optional context. Returns { ok, kind, message, page } or
// { ok:false, error }.
export function normalizeFeedback(body) {
  const b = body || {};
  const kind = b.kind === 'bug' ? 'bug' : 'idea';
  const message = String(b.message == null ? '' : b.message).trim().slice(0, 4000);
  const page = String(b.page == null ? '' : b.page).trim().slice(0, 200) || null;
  if (message.length < 2) {
    return { ok: false, error: 'Please add a little more detail.' };
  }
  return { ok: true, kind, message, page };
}

// Build the Linear issue { title, description } from a stored feedback row.
// Title is tagged by kind and clipped to a single short line; description keeps
// the full message plus provenance (reporter email, originating page).
export function buildLinearIssue(item) {
  const f = item || {};
  const message = String(f.message == null ? '' : f.message);
  const title = (f.kind === 'bug' ? '[Bug] ' : '[Idea] ') + message.slice(0, 80).replace(/\s+/g, ' ').trim();
  const description = [
    message,
    '',
    '---',
    '_From in-app feedback_',
    f.email ? '- Reporter: ' + f.email : null,
    f.page ? '- Page: ' + f.page : null,
  ].filter(Boolean).join('\n');
  return { title, description };
}
