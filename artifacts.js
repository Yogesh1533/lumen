// The artifacts of the chats: the html, svg and markdown blocks of the answers — the
// same rule the page uses (collectArtifacts in public/app.js). The library lists them
// across the chats; the pop-out serves one of them as a page of its own, under
// "Content-Security-Policy: sandbox allow-scripts", so it keeps an opaque origin and
// cannot reach the API or the data of Lumen.
const LANGS = { html: 'html', svg: 'svg', markdown: 'md', md: 'md' };
const EXT = { html: 'html', svg: 'svg', md: 'md' };

function collect(chat) {
  const out = [];
  (chat.messages || []).forEach((m, mi) => {
    if (m.role !== 'assistant') return;
    const re = /```(html|svg|markdown|md)[^\n]*\n([\s\S]*?)(?:```|$)/gi;
    let x, n = 0;
    while ((x = re.exec(m.content || ''))) out.push({ mi, n: n++, lang: LANGS[x[1].toLowerCase()], code: x[2].replace(/\n$/, ''), t: m.t || chat.updated || 0 });
  });
  return out;
}
function title(a) {
  const t = a.lang === 'html' ? (a.code.match(/<title[^>]*>([^<]+)<\/title>/i) || a.code.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1]
    : a.lang === 'md' ? (a.code.match(/^#{1,3}\s+(.+)$/m) || [])[1] : null;
  return (t || { html: 'HTML page', svg: 'SVG image', md: 'Document' }[a.lang]).trim().slice(0, 80);
}
// Every artifact of every chat, newest first; `q` searches the title, the chat title and
// the code.
function list(chats, q = '') {
  const needle = String(q || '').toLowerCase().trim();
  const out = [];
  for (const c of Object.values(chats)) {
    for (const a of collect(c)) {
      const item = { chat: c.id, chatTitle: c.title, mi: a.mi, n: a.n, lang: a.lang, title: title(a), size: a.code.length, t: a.t, ext: EXT[a.lang] };
      if (needle && !(`${item.title}\n${item.chatTitle}\n${a.code}`.toLowerCase().includes(needle))) continue;
      out.push(item);
    }
  }
  return out.sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, 500);
}
function find(chats, chatId, mi, n) {
  const c = chats[chatId];
  if (!c) return null;
  return collect(c).find((a) => a.mi === Number(mi) && a.n === Number(n)) || null;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
// The page of a pop-out. Markdown is shown as its text (the renderer of the app is in
// the page, and this page has no app).
function page(a) {
  if (a.lang === 'html') return a.code;
  if (a.lang === 'svg') return `<!doctype html><meta charset="utf-8"><title>${esc(title(a))}</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${a.code}</body>`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(title(a))}</title><style>body{font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1b1b24}pre{white-space:pre-wrap;font:inherit}</style><pre>${esc(a.code)}</pre>`;
}
const POP_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // The page gets an opaque origin of its own: no API, no cookies, no storage of Lumen.
  'Content-Security-Policy': 'sandbox allow-scripts',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
module.exports = { collect, title, list, find, page, POP_HEADERS, EXT };
