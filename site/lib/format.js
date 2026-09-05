// Pure formatting/rendering helpers for the web app, extracted from app.html so
// they can be unit-tested (node:test) and reused. app.html loads this as a module
// and assigns the exports onto window; nothing here touches the DOM or globals.

// HTML-escape a value for safe interpolation into markup.
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// "Sep 5" style short date; '' for empty/invalid input.
export function fmtShortDate(iso) {
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Time-of-day if the timestamp is today, otherwise a short date; '' if invalid.
export function fmtNoteTime(iso) {
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d.getTime())) return '';
  var today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Tiny, safe Markdown → HTML (escape first, then apply a small subset).
export function ntMarkdown(src) {
  var lines = String(src || '').split('\n');
  var html = '', inUl = false, inPre = false;
  function inline(t) {
    t = escapeHtml(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^```/.test(ln)) { if (inPre) { html += '</pre>'; inPre = false; } else { if (inUl) { html += '</ul>'; inUl = false; } html += '<pre>'; inPre = true; } continue; }
    if (inPre) { html += escapeHtml(ln) + '\n'; continue; }
    var h = ln.match(/^(#{1,3})\s+(.*)$/);
    if (h) { if (inUl) { html += '</ul>'; inUl = false; } html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
    var todo = ln.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/);
    var li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (todo || li) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      if (todo) { html += '<li>' + (todo[1].toLowerCase() === 'x' ? '☑' : '☐') + ' ' + inline(todo[2]) + '</li>'; }
      else { html += '<li>' + inline(li[1]) + '</li>'; }
      continue;
    }
    if (inUl) { html += '</ul>'; inUl = false; }
    if (ln.trim() === '') html += '<br>';
    else html += '<p>' + inline(ln) + '</p>';
  }
  if (inUl) html += '</ul>';
  if (inPre) html += '</pre>';
  return html;
}
