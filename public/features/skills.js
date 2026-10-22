'use strict';
// Step 10 — skills: the Skills dialog (list, switch a skill on and off, write and edit
// SKILL.md, upload a zip or loose files, delete) and the approval of the skills tools.
// Loaded after app.js. Both are classic scripts, so app.js's top-level consts (state, api,
// esc, pref, …) live in the same global scope and are used here.

// The two tools of the skills server. Their names are the ones the model calls.
const SKILL_TOOLS = [
  { name: 'use_skill', label: 'Ask before a skill is used', desc: 'Loads the SKILL.md of a skill.' },
  { name: 'read_skill_file', label: 'Ask before a file of a skill is read', desc: 'Reads one file of a skill.' },
];
// The approval is kept in Lumen's own store, keyed by server and tool.
const skillAllowKey = (tool) => 'skills/' + tool;
const kbLabel = (n) => (n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB');

// ---- the list of the skills ------------------------------------------------
function renderSkillList() {
  const box = $('#skillList');
  box.innerHTML = '';
  const list = (state.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) { box.innerHTML = '<p class="sub">No skills yet. Create one or upload a zip.</p>'; return; }
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'skill';
    d.dataset.name = s.name;
    const files = (s.files || []).length;
    d.innerHTML = `<label class="toggle"><input type="checkbox" class="en" ${s.enabled ? 'checked' : ''}> On</label>
      <div class="skmain">
        <div class="nm">${esc(s.name)}</div>
        <div class="meta">${esc(s.description || 'No description')}</div>
        <div class="meta">${files} file${files === 1 ? '' : 's'} · ${kbLabel(s.size || 0)}</div>
      </div>
      <button type="button" class="ghost" data-a="edit">Edit</button>
      <button type="button" class="icon" data-a="del" title="Delete">✕</button>`;
    // The switch of a skill: on means the model may use it.
    d.querySelector('input.en').onchange = async (e) => {
      const on = e.target.checked;
      try { await api('/skills/' + encodeURIComponent(s.name), { method: 'PUT', body: { enabled: on } }); }
      catch (err) { toast(err.message); e.target.checked = !on; return; }
      await loadSkills();
      renderSkillList();
    };
    d.querySelector('[data-a=edit]').onclick = () => openSkillEditor(s.name);
    d.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Delete the skill "${s.name}"? Its files are removed.`)) return;
      try { await api('/skills/' + encodeURIComponent(s.name), { method: 'DELETE' }); }
      catch (err) { return toast(err.message); }
      await loadSkills();
      renderSkillList();
      toast('Skill deleted');
    };
    box.appendChild(d);
  }
}

// ---- the approval of the skills tools ---------------------------------------
// Nothing is ever approved on its own: a tool asks until the user says "always".
function renderSkillTools() {
  const box = $('#skillTools');
  box.innerHTML = '';
  for (const t of SKILL_TOOLS) {
    const ask = !toolAllow().has(skillAllowKey(t.name));
    const row = document.createElement('label');
    row.className = 'tog';
    row.dataset.tool = t.name;
    row.innerHTML = `<input type="checkbox" ${ask ? 'checked' : ''}><span class="tn">${esc(t.label)}</span><span class="td">${esc(t.desc)}</span>`;
    row.querySelector('input').onchange = (e) => {
      const a = toolAllow();
      if (e.target.checked) a.delete(skillAllowKey(t.name)); else a.add(skillAllowKey(t.name));
      saveAllow(a);
      renderMcp();
      toast(e.target.checked ? 'Lumen asks before every call' : 'Always allowed: ' + t.name);
    };
    box.appendChild(row);
  }
}

// ---- the editor of a skill --------------------------------------------------
let editingSkill = null;   // the skill that is open in the editor
async function openSkillEditor(name) {
  let s;
  try { s = await api('/skills/' + encodeURIComponent(name)); }
  catch (e) { return toast(e.message); }
  editingSkill = s;
  $('#skTitle').textContent = 'Skill: ' + s.name;
  $('#skName').value = s.name;
  $('#skContent').value = s.content || '';
  renderSkillFiles(s);
  if (!$('#skillEditDlg').open) $('#skillEditDlg').showModal();
}
function renderSkillFiles(s) {
  const box = $('#skFiles');
  box.innerHTML = '';
  $('#skSize').textContent = (s.files || []).length + ' files · ' + kbLabel(s.size || 0);
  for (const f of s.files || []) {
    const d = document.createElement('div');
    d.className = 'pfile';
    d.innerHTML = `<span>📄</span><span class="nm">${esc(f.path)}</span><span class="meta">${kbLabel(f.size)}</span><button type="button" class="icon" title="Remove">✕</button>`;
    d.querySelector('button').onclick = async () => {
      try { await api(`/skills/${encodeURIComponent(s.name)}/files?path=${encodeURIComponent(f.path)}`, { method: 'DELETE' }); }
      catch (e) { return toast(e.message); }
      openSkillEditor(s.name);
    };
    box.appendChild(d);
  }
}
$('#skSave').onclick = async () => {
  if (!editingSkill) return;
  try { await api('/skills/' + encodeURIComponent(editingSkill.name), { method: 'PUT', body: { content: $('#skContent').value } }); }
  catch (e) { return toast(e.message); }
  $('#skillEditDlg').close();
  await loadSkills();
  renderSkillList();
  toast('Skill saved');
};
$('#skCancel').onclick = () => $('#skillEditDlg').close();
$('#skDelete').onclick = async () => {
  if (!editingSkill) return;
  if (!confirm(`Delete the skill "${editingSkill.name}"? Its files are removed.`)) return;
  try { await api('/skills/' + encodeURIComponent(editingSkill.name), { method: 'DELETE' }); }
  catch (e) { return toast(e.message); }
  $('#skillEditDlg').close();
  await loadSkills();
  renderSkillList();
  toast('Skill deleted');
};
// More files in the folder of the skill.
$('#skAddFiles').onclick = () => $('#skFileInput').click();
$('#skFileInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!editingSkill) return;
  for (const f of files) {
    try {
      const data = (await fileToDataURL(f)).split(',')[1];
      await api(`/skills/${encodeURIComponent(editingSkill.name)}/files`, { method: 'POST', body: { path: f.name, data } });
    } catch (err) { toast(f.name + ': ' + (err.message || err)); }
  }
  openSkillEditor(editingSkill.name);
};

// ---- a new skill and a zip that is uploaded ----------------------------------
// The warning before an upload replaces a skill that is already there: the old files
// are removed, so the user has to know it.
function skillReplaceWarning(name) {
  const old = (state.skills || []).find((s) => s.name === name);
  if (!old) return '';
  const files = (old.files || []).length;
  return `There is already a skill called "${old.name}". This upload replaces it: its ${files} file${files === 1 ? '' : 's'} (${kbLabel(old.size || 0)}) are removed and the bundle takes their place. Continue?`;
}
$('#skillNew').onclick = async () => {
  const name = prompt('The name of the new skill (a-z, 0-9, "-" and "_", at most 40 characters):');
  if (!name) return;
  let s;
  try { s = await api('/skills', { method: 'POST', body: { name: name.trim() } }); }
  catch (e) { return toast(e.message); }
  await loadSkills();
  renderSkillList();
  openSkillEditor(s.name);
};
$('#skillUpload').onclick = () => $('#skillZipInput').click();
$('#skillZipInput').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const guess = f.name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40);
  const name = prompt('The name of the skill in this zip:', guess);
  if (!name) return;
  const warn = skillReplaceWarning(name.trim());
  if (warn && !confirm(warn)) return; // the skill of the user stays as it is
  try {
    const data = (await fileToDataURL(f)).split(',')[1];
    await api('/skills/upload', { method: 'POST', body: { name: name.trim(), file: data } });
  } catch (err) { return toast(err.message); }
  await loadSkills();
  renderSkillList();
  toast('Skill uploaded');
};

// ---- the dialog --------------------------------------------------------------
$('#skillsBtn').onclick = async () => {
  await loadSkills();
  renderSkillList();
  renderSkillTools();
  if (!$('#skillsDlg').open) $('#skillsDlg').showModal();
};
$('#skillsClose').onclick = () => $('#skillsDlg').close();
