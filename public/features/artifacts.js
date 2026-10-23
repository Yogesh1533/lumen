// Step 15 — AI-powered artifacts, the artifact library and the pop-out.
//
// An artifact stays in its sandbox (an opaque origin: no API, no cookies, no storage of
// Lumen). The page gives it a small bridge over postMessage:
//   window.lumen.ask(prompt)        -> the answer of the model of the chat (text)
//   window.lumen.storage.get/set/remove/keys   -> up to 100 KB of data of its own
//   window.lumen.openLink(url)      -> asks the user, then opens an http(s) link
// The first use asks the user (per artifact), the calls are rate- and size-limited, and
// a badge in the header of the artifact shows that it uses Lumen. A plain link click in
// the artifact goes through openLink too.

const ART_LIMITS = { promptChars: 4000, answerChars: 20000, asksPerMinute: 10, storeBytes: 100 * 1024, valueBytes: 20 * 1024, keys: 200, keyChars: 200 };
const artState = { consent: null, denied: new Set(), asks: new Map(), busy: 0, used: new Set() };

// The bridge, as the first script of the artifact's document.
const ART_BRIDGE = `<script>(() => {
  const pend = new Map(); let n = 0;
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = ++n; pend.set(id, { resolve, reject });
    parent.postMessage({ __lumen: 1, id, op, args }, '*');
  });
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.__lumen !== 2 || !pend.has(d.id)) return;
    const p = pend.get(d.id); pend.delete(d.id);
    if (d.error) p.reject(new Error(d.error)); else p.resolve(d.value);
  });
  const storage = Object.freeze({
    get: (key) => call('get', { key: String(key) }),
    set: (key, value) => call('set', { key: String(key), value }),
    remove: (key) => call('remove', { key: String(key) }),
    keys: () => call('keys', {}),
  });
  Object.defineProperty(window, 'lumen', { value: Object.freeze({ ask: (prompt) => call('ask', { prompt: String(prompt) }), storage, openLink: (url) => call('link', { url: String(url) }) }) });
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    e.preventDefault();
    call('link', { url: a.href }).catch(() => {});
  }, true);
})();</` + `script>`;

const prevArtDoc = hooks.artDoc;
hooks.artDoc = (doc, a) => {
  if (prevArtDoc) doc = prevArtDoc(doc, a);
  // After the doctype, so the page does not fall into quirks mode.
  const m = doc.match(/^\s*<!doctype[^>]*>/i);
  return m ? m[0] + ART_BRIDGE + doc.slice(m[0].length) : ART_BRIDGE + doc;
};

// The identity of an artifact: its chat and its title — the versions of one artifact in
// a chat share their consent and their data.
function artKey(a) {
  if (!a) return null;
  return (state.chat.id || 'unsaved') + '|' + artTitle(a);
}
const artCurrent = () => state.art.list[state.art.i];
function artConsents() {
  if (!artState.consent) { try { artState.consent = JSON.parse(pref('artConsent') || '{}'); } catch (e) { artState.consent = {}; } }
  return artState.consent;
}
function artAskConsent(a) {
  return new Promise((resolve) => {
    const dlg = $('#artConsentDlg');
    $('#artConsentText').textContent = `“${artTitle(a)}” wants to ask the model (${state.chat.model || $('#modelSelect').value}) and keep data of its own.`;
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'yes');
    dlg.showModal();
  });
}
async function artAllowed(a) {
  const key = artKey(a);
  if (artConsents()[key]) return true;
  if (artState.denied.has(key)) return false;
  const yes = await artAskConsent(a);
  if (yes) { artState.consent[key] = Date.now(); pref('artConsent', JSON.stringify(artState.consent)); }
  else artState.denied.add(key);
  return yes;
}
function artBadge() {
  const a = artCurrent(), b = $('#artAi');
  b.hidden = !(a && artState.used.has(artKey(a)));
  b.classList.toggle('busy', artState.busy > 0);
  b.textContent = artState.busy > 0 ? '✦ AI · asking…' : '✦ AI';
}

// ---- the storage of an artifact ---------------------------------------------------------
const storeKey = (a) => 'artStore.' + artKey(a);
function storeRead(a) { try { return JSON.parse(pref(storeKey(a)) || '{}'); } catch (e) { return {}; } }
function storeWrite(a, o) {
  const text = JSON.stringify(o);
  if (text.length > ART_LIMITS.storeBytes) throw new Error(`The storage of this artifact is full (${ART_LIMITS.storeBytes / 1024} KB)`);
  pref(storeKey(a), text);
}

// ---- ask --------------------------------------------------------------------------------
async function artAsk(a, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('The prompt is empty');
  if (prompt.length > ART_LIMITS.promptChars) throw new Error(`The prompt is longer than ${ART_LIMITS.promptChars} characters`);
  const key = artKey(a), now = Date.now();
  const recent = (artState.asks.get(key) || []).filter((t) => now - t < 60000);
  if (recent.length >= ART_LIMITS.asksPerMinute) throw new Error(`At most ${ART_LIMITS.asksPerMinute} prompts a minute`);
  if (artState.busy) throw new Error('One prompt at a time');
  recent.push(now); artState.asks.set(key, recent);
  const model = $('#modelSelect').value;
  // The same consent as a chat: a cloud model asks first, a local-only project refuses it.
  if (hooks.beforeGenerate && (await hooks.beforeGenerate(model, state.chat, 'artifact')) === false) throw new Error('Not sent: the model needs your consent');
  artState.busy++; artBadge();
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, chat: state.chat.id, project: state.chat.project || null, think: false, options: { temperature: 0.4 },
        system: 'You answer a request of an interactive artifact (a small web app the user is using inside Lumen). Answer the request directly and briefly. Use plain text, or exactly the format the request asks for (for example JSON).',
        messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message && j.message.content) out += j.message.content;
        if (out.length > ART_LIMITS.answerChars) { reader.cancel(); return out.slice(0, ART_LIMITS.answerChars); }
      }
    }
    return out;
  } finally { artState.busy--; artBadge(); }
}

// ---- the messages of the artifact -------------------------------------------------------------
window.addEventListener('message', async (e) => {
  const frame = $('#artFrame');
  // Only the artifact preview of this page, with its opaque origin.
  if (!frame || e.source !== frame.contentWindow || e.origin !== 'null') return;
  const d = e.data;
  if (!d || d.__lumen !== 1 || typeof d.id !== 'number' || typeof d.op !== 'string') return;
  const a = artCurrent();
  const reply = (value, error) => { try { e.source.postMessage({ __lumen: 2, id: d.id, value, error }, '*'); } catch (x) { /* gone */ } };
  if (!a) return reply(null, 'No artifact');
  const args = d.args && typeof d.args === 'object' ? d.args : {};
  try {
    if (d.op === 'link') {
      let u;
      try { u = new URL(String(args.url)); } catch (x) { throw new Error('That is not a link'); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) links can be opened');
      if (!confirm(`This artifact wants to open a link:\n\n${u.href}\n\nOpen it in a new tab?`)) return reply(false);
      window.open(u.href, '_blank', 'noopener,noreferrer');
      return reply(true);
    }
    if (!['ask', 'get', 'set', 'remove', 'keys'].includes(d.op)) throw new Error('Unknown call');
    if (!(await artAllowed(a))) throw new Error('The user did not allow this artifact to use Lumen');
    artState.used.add(artKey(a)); artBadge();
    if (d.op === 'ask') return reply(await artAsk(a, args.prompt));
    const store = storeRead(a);
    const k = String(args.key == null ? '' : args.key);
    if (d.op !== 'keys' && (!k || k.length > ART_LIMITS.keyChars)) throw new Error('A key is 1 to 200 characters');
    if (d.op === 'get') return reply(Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null);
    if (d.op === 'keys') return reply(Object.keys(store));
    if (d.op === 'remove') { delete store[k]; storeWrite(a, store); return reply(true); }
    // set: the value must be plain data and not too big.
    let text;
    try { text = JSON.stringify(args.value); } catch (x) { throw new Error('The value must be plain data (JSON)'); }
    if (text === undefined) throw new Error('The value must be plain data (JSON)');
    if (text.length > ART_LIMITS.valueBytes) throw new Error(`A value is at most ${ART_LIMITS.valueBytes / 1024} KB`);
    if (!(k in store) && Object.keys(store).length >= ART_LIMITS.keys) throw new Error(`At most ${ART_LIMITS.keys} keys`);
    store[k] = JSON.parse(text);
    storeWrite(a, store);
    return reply(true);
  } catch (err) { return reply(null, String(err.message || err)); }
});
// The badge follows the artifact that is shown.
const prevArtDoc2 = hooks.artDoc;
hooks.artDoc = (doc, a) => { const out = prevArtDoc2(doc, a); setTimeout(artBadge, 0); return out; };

// ---- pop-out ---------------------------------------------------------------------------------
$('#artPop').onclick = () => {
  const a = artCurrent();
  if (!a) return;
  if (!state.chat.id) return toast('Save the chat first (a temporary chat has no pop-out)');
  window.open(`/pop/${encodeURIComponent(state.chat.id)}/${a.mi}/${a.n}`, '_blank', 'noopener');
};

// ---- the library -------------------------------------------------------------------------------
let libTimer = 0;
async function libRender() {
  let list = [];
  try { list = await api('/artifacts?q=' + encodeURIComponent($('#libQ').value)); } catch (e) { toast(e.message); }
  $('#libN').textContent = `${list.length} artifact${list.length === 1 ? '' : 's'}`;
  const box = $('#libList');
  box.innerHTML = list.length ? '' : '<p class="sub">No artifact yet — ask for an HTML page, an SVG or a document.</p>';
  for (const it of list) {
    const d = document.createElement('div'); d.className = 'libitem';
    d.dataset.chat = it.chat; d.dataset.mi = it.mi; d.dataset.n = it.n;
    d.innerHTML = `<span class="tt"><b>${esc(it.title)}</b> <span class="sub">${esc(it.lang)} · ${esc(it.chatTitle)} · ${new Date(it.t || 0).toLocaleDateString()}</span></span>
      <button type="button" class="ghost" data-a="open">Open</button><button type="button" class="ghost" data-a="pop">Pop out</button><button type="button" class="ghost" data-a="dl">Download</button>`;
    d.querySelector('[data-a=open]').onclick = async () => { $('#libDlg').close(); await openChat(it.chat); openArtifact(it.mi, it.n); };
    d.querySelector('[data-a=pop]').onclick = () => window.open(`/pop/${encodeURIComponent(it.chat)}/${it.mi}/${it.n}`, '_blank', 'noopener');
    d.querySelector('[data-a=dl]').onclick = async () => {
      const a = await api(`/artifacts/${encodeURIComponent(it.chat)}/${it.mi}/${it.n}`);
      const url = URL.createObjectURL(new Blob([a.code], { type: 'text/plain' }));
      const l = document.createElement('a'); l.href = url; l.download = `${a.title.replace(/[^\w-]+/g, '-').toLowerCase()}.${a.ext}`;
      l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    box.appendChild(d);
  }
}
$('#libBtn').onclick = () => { $('#libQ').value = ''; libRender(); $('#libDlg').showModal(); };
$('#libClose').onclick = () => $('#libDlg').close();
$('#libQ').oninput = () => { clearTimeout(libTimer); libTimer = setTimeout(libRender, 200); };
