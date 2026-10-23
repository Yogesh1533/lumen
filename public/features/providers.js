// Step 14 — models and providers: the one-time consent before a prompt goes to a model
// outside this computer, "Local only" projects, the default model, and the
// OpenAI-compatible providers (their keys go into the secret store of the server).
//
// The server enforces all of it (a prompt without consent, or a cloud model in a local
// project, is refused by /api/chat); this page asks first so the user is not surprised.

const pvState = { providers: [], presets: [], caps: [], consent: {}, editing: null, store: null };

// The destination of a model, the same way the server computes it.
function pvDest(model) {
  const m = (state.models || []).find((x) => x.id === model);
  if (!m || !m.cloud) return null;
  if (m.providerId) { const p = pvState.providers.find((x) => x.id === m.providerId); return { id: m.providerId, label: p ? `${p.name} (${pvHost(p.baseUrl)})` : m.provider }; }
  return { id: 'ollama-cloud', label: "Ollama's cloud" };
}
const pvHost = (u) => { try { return new URL(u).host; } catch (e) { return u; } };
const pvProject = (c) => (c && c.project && (state.projects || []).find((p) => p.id === c.project)) || null;

async function pvLoad() {
  try {
    const r = await api('/providers');
    pvState.providers = r.providers; pvState.presets = r.presets; pvState.caps = r.caps; pvState.store = r.secretStore;
    pvState.consent = (await api('/consent')).consent || {};
  } catch (e) { /* an older server */ }
}

// ---- the consent ---------------------------------------------------------------------------
function pvAsk(model, dest) {
  return new Promise((resolve) => {
    const dlg = $('#consentDlg');
    $('#consentText').textContent = `Prompts to ${model} are processed by ${dest.label}, not on this computer.`;
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'yes');
    dlg.showModal();
  });
}
const pvPrevGen = hooks.beforeGenerate;
hooks.beforeGenerate = async (model, c) => {
  if (pvPrevGen && (await pvPrevGen(model, c)) === false) return false;
  const dest = pvDest(model);
  if (!dest) return true;
  const proj = pvProject(c);
  if (proj && proj.localOnly) { toast(`“${proj.name}” is local only: ${model} runs outside this computer`); return false; }
  if (pvState.consent[dest.id]) return true;
  if (!(await pvAsk(model, dest))) { toast('Not sent'); return false; }
  try { pvState.consent = (await api('/consent', { method: 'POST', body: { dest: dest.id } })).consent; } catch (e) { toast(e.message); return false; }
  return true;
};

// ---- "Local only" projects -----------------------------------------------------------------
// The cloud models cannot be picked in a chat of a local-only project.
function pvMarkLocal() {
  const proj = pvProject(state.chat);
  const local = !!(proj && proj.localOnly);
  const sel = $('#modelSelect');
  for (const o of sel.options) if (o.dataset.cloud) o.disabled = local;
  if (local && sel.selectedOptions[0] && sel.selectedOptions[0].dataset.cloud) {
    const first = [...sel.options].find((o) => !o.dataset.cloud);
    if (first) { sel.value = first.value; sel.dispatchEvent(new Event('change')); toast(`Local only project: switched to ${first.value}`); }
  }
  sel.title = local ? 'This project is local only: cloud models are switched off' : '';
}

// ---- the default model ------------------------------------------------------------------------
function pvApplyDefault() {
  const d = state.settings && state.settings.defaultModel;
  if (!d || !(state.models || []).some((m) => m.id === d)) return;
  if (state.chat.messages.length || state.chat.id) return;
  $('#modelSelect').value = d;
  $('#modelSelect').dispatchEvent(new Event('change'));
}

const pvPrevNew = hooks.onNewChat;
hooks.onNewChat = () => { if (pvPrevNew) pvPrevNew(); pvApplyDefault(); pvMarkLocal(); };
const pvPrevOpen = hooks.onOpenChat;
hooks.onOpenChat = (chat) => { if (pvPrevOpen) pvPrevOpen(chat); pvMarkLocal(); };

// ---- the dialog -----------------------------------------------------------------------------------
function pvRender() {
  const d = $('#defModel');
  d.innerHTML = '<option value="">Last used</option>' + (state.models || []).map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}${m.cloud ? ' ☁' : ''}</option>`).join('');
  d.value = (state.settings && state.settings.defaultModel) || '';
  // The destinations the user allowed.
  const cl = $('#consentList');
  const ids = Object.keys(pvState.consent || {});
  cl.innerHTML = ids.length ? '' : '<p class="sub">No destination outside this computer is allowed yet.</p>';
  for (const id of ids) {
    const p = pvState.providers.find((x) => x.id === id);
    const row = document.createElement('div'); row.className = 'allow';
    row.innerHTML = `<code>${esc(id === 'ollama-cloud' ? "Ollama's cloud" : p ? `${p.name} (${pvHost(p.baseUrl)})` : id)}</code><button type="button" class="ghost">Revoke</button>`;
    row.querySelector('button').onclick = async () => { pvState.consent = (await api('/consent', { method: 'DELETE', body: { dest: id } })).consent; pvRender(); };
    cl.appendChild(row);
  }
  const list = $('#provList');
  list.innerHTML = pvState.providers.length ? '' : '<p class="sub">No provider yet.</p>';
  for (const p of pvState.providers) {
    const row = document.createElement('div'); row.className = 'mcp'; row.dataset.id = p.id;
    row.innerHTML = `<div class="mh"><span class="nm">${esc(p.name)}</span><span class="meta">${p.local ? 'on this computer' : '☁ ' + esc(pvHost(p.baseUrl))} · ${p.models.length} models · ${p.hasKey ? 'key stored' : 'no key'}</span>
      <button type="button" class="ghost" data-a="ed">Edit</button><button type="button" class="icon" data-a="rm" title="Remove">✕</button></div>
      <div class="meta">${esc(p.baseUrl)}</div>`;
    row.querySelector('[data-a=ed]').onclick = () => pvEdit(p);
    row.querySelector('[data-a=rm]').onclick = async () => {
      if (!confirm(`Remove ${p.name}? Its key is deleted from the secret store.`)) return;
      await api('/providers/' + p.id, { method: 'DELETE' }).catch((e) => toast(e.message));
      await pvAfter();
    };
    list.appendChild(row);
  }
  $('#pvPreset').innerHTML = '<option value="">Preset…</option>' + pvState.presets.map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('');
  $('#pvCaps').innerHTML = 'The models can use: ' + pvState.caps.map((c) => `<label class="check"><input type="checkbox" data-cap="${c}"> ${c}</label>`).join(' ');
  if (pvState.editing) for (const c of pvState.editing.caps || []) { const x = document.querySelector(`#pvCaps [data-cap=${c}]`); if (x) x.checked = true; }
  const st = pvState.store || {};
  $('#secretStore').textContent = st.label ? `Secrets (provider keys, the Brave key, MCP environment values) are kept in: ${st.label}.` : '';
  $('#secretWarn').hidden = !st.warning; $('#secretWarn').textContent = st.warning || '';
}
function pvEdit(p) {
  pvState.editing = p;
  $('#pvName').value = p ? p.name : ''; $('#pvUrl').value = p ? p.baseUrl : ''; $('#pvKey').value = '';
  $('#pvKey').placeholder = p && p.hasKey ? 'API key (stored — leave empty to keep it)' : 'API key (optional for a local server)';
  $('#pvModels').value = p ? p.models.join('\n') : '';
  $('#pvSave').textContent = p ? 'Save provider' : 'Add provider';
  $('#pvCancel').hidden = !p; $('#pvFetch').hidden = !p;
  $('#pvMsg').textContent = '';
  pvRender();
}
async function pvAfter() {
  await pvLoad();
  try { const { models } = await api('/models'); state.models = models;
    const sel = $('#modelSelect'), cur = sel.value;
    sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}"${m.cloud ? ' data-cloud="1"' : ''}>${esc(m.label || m.id)}${m.cloud ? ' ☁' : ''}</option>`).join('');
    if (models.some((m) => m.id === cur)) sel.value = cur;
    updateThinkUI();
  } catch (e) { /* the list stays */ }
  pvMarkLocal();
  pvRender();
}
$('#pvPreset').onchange = () => {
  const x = pvState.presets.find((p) => p.key === $('#pvPreset').value);
  $('#pvNote').textContent = x ? x.note : '';
  if (!x) return;
  $('#pvName').value = x.name; $('#pvUrl').value = x.baseUrl; $('#pvModels').value = x.models.join('\n');
  for (const c of pvState.caps) { const el = document.querySelector(`#pvCaps [data-cap=${c}]`); if (el) el.checked = x.caps.includes(c); }
};
$('#pvCancel').onclick = () => pvEdit(null);
$('#pvSave').onclick = async () => {
  const body = { name: $('#pvName').value, baseUrl: $('#pvUrl').value, models: $('#pvModels').value,
    caps: [...document.querySelectorAll('#pvCaps input:checked')].map((x) => x.dataset.cap) };
  if ($('#pvKey').value.trim()) body.apiKey = $('#pvKey').value.trim();
  try {
    if (pvState.editing) await api('/providers/' + pvState.editing.id, { method: 'PUT', body });
    else await api('/providers', { method: 'POST', body });
    $('#pvKey').value = '';
    pvEdit(null);
    $('#pvMsg').textContent = 'Saved.';
    await pvAfter();
  } catch (e) { $('#pvMsg').textContent = e.message; }
};
$('#pvFetch').onclick = async () => {
  if (!pvState.editing) return;
  $('#pvMsg').textContent = 'Asking the provider…';
  try { const r = await api(`/providers/${pvState.editing.id}/models`, { method: 'POST' }); $('#pvModels').value = r.models.join('\n'); $('#pvMsg').textContent = `${r.models.length} models — keep the ones you want and save.`; }
  catch (e) { $('#pvMsg').textContent = e.message; }
};
$('#defModel').onchange = async () => {
  try { state.settings = await api('/settings', { method: 'PUT', body: { defaultModel: $('#defModel').value } }); toast('Default model saved'); } catch (e) { toast(e.message); }
};
$('#provBtn').onclick = async () => { await pvLoad(); pvEdit(null); $('#provDlg').showModal(); };
$('#provClose').onclick = () => $('#provDlg').close();

state.ready.then(async () => {
  await pvLoad();
  try { state.settings = await api('/settings'); } catch (e) { /* kept */ }
  pvApplyDefault();
  pvMarkLocal();
});
