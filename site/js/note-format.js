/* Note formatting + sanitization — the single source of truth shared by the web
 * editor (app.html) and, in spirit, the public share page. Loaded as a classic
 * script so its functions are globals, visible both to app.html's IIFE and to
 * headless tests (e2e/note-format.spec.js) that call them via page.evaluate.
 *
 * SECURITY: ntSanitize is an XSS boundary. Note bodies can arrive as raw HTML
 * from the mobile app or a direct API call and are re-sanitized on load, so this
 * must strip scripts, event handlers, and javascript: URLs — not just trust the
 * browser. Changes here are covered by the round-trip test corpus (KRA-70).
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Legacy plain-text / markdown notes → HTML. Each source line becomes a block
  // so single newlines are preserved (KRA-61); blank lines become <br>.
  function ntMarkdown(src) {
    var lines = String(src || '').split('\n');
    var html = '', inUl = false, inPre = false;
    function inline(t) {
      t = escapeHtml(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>')
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

  // Tags kept from the contenteditable output. Everything else is unwrapped.
  var NT_ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, MARK: 1, SPAN: 1, CODE: 1, PRE: 1, BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, P: 1, BR: 1, DIV: 1, A: 1 };

  // Preserve a small, safe set of inline styles (text color, highlight, bold,
  // underline/strike) so pasted/typed formatting survives save→reload (KRA-114).
  // Values are read from the browser-parsed CSSStyleDeclaration, so they can't
  // carry script or url()/expression() — only normalized color/weight values.
  function ntCleanStyle(el) {
    var out = '';
    var skip = { '': 1, initial: 1, inherit: 1, transparent: 1, 'rgba(0, 0, 0, 0)': 1 };
    var color = el.style.color; if (color && !skip[color]) out += 'color:' + color + ';';
    var bg = el.style.backgroundColor; if (bg && !skip[bg]) out += 'background-color:' + bg + ';';
    var fw = el.style.fontWeight; if (fw === 'bold' || parseInt(fw, 10) >= 600) out += 'font-weight:' + fw + ';';
    var td = el.style.textDecorationLine || el.style.textDecoration;
    if (td && /line-through|underline/.test(td)) out += 'text-decoration:' + td + ';';
    return out;
  }

  function ntSanitize(html) {
    var root = document.createElement('div'); root.innerHTML = html || '';
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 1) {
          if (!NT_ALLOWED[c.tagName]) {
            while (c.firstChild) node.insertBefore(c.firstChild, c);
            node.removeChild(c);
            return;
          }
          var href = c.tagName === 'A' ? c.getAttribute('href') : null;
          var style = ntCleanStyle(c); // read before stripping attributes
          Array.prototype.slice.call(c.attributes).forEach(function (a) { c.removeAttribute(a.name); });
          if (href && /^(https?:|mailto:|\/|#)/i.test(href)) c.setAttribute('href', href);
          if (style) c.setAttribute('style', style);
          // A span that carries no surviving formatting is just noise — unwrap it.
          if (c.tagName === 'SPAN' && !style) { while (c.firstChild) node.insertBefore(c.firstChild, c); node.removeChild(c); return; }
          walk(c);
        }
      });
    })(root);
    return root.innerHTML;
  }

  // Editor stores HTML. Legacy notes were markdown/plain text — convert those to
  // HTML on load so they render in the rich editor. HTML bodies are re-sanitized
  // on load too (a body from mobile / a direct API call never hit the save-time
  // sanitizer, so trusting it here would be stored-XSS on open).
  function ntBodyToHtml(stored) {
    if (!stored) return '';
    if (/<(b|strong|i|em|u|s|mark|code|pre|blockquote|ul|ol|li|h[1-3]|p|div|br|a|span)\b/i.test(stored)) return ntSanitize(stored);
    return ntMarkdown(stored);
  }

  var api = { escapeHtml: escapeHtml, ntMarkdown: ntMarkdown, ntCleanStyle: ntCleanStyle, ntSanitize: ntSanitize, ntBodyToHtml: ntBodyToHtml, NT_ALLOWED: NT_ALLOWED };
  // Expose both as bare globals (so app.html's IIFE picks them up unchanged) and
  // under a namespace (so tests have a stable handle).
  global.escapeHtml = escapeHtml;
  global.ntMarkdown = ntMarkdown;
  global.ntCleanStyle = ntCleanStyle;
  global.ntSanitize = ntSanitize;
  global.ntBodyToHtml = ntBodyToHtml;
  global.NT_ALLOWED = NT_ALLOWED;
  global.NoteFormat = api;
})(typeof window !== 'undefined' ? window : this);
