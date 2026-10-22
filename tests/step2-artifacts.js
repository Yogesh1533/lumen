const { launch, sleep } = require('./lib/cdplib');

// Sandboxed iframes get their own process in Chrome, which headless CDP cannot drive. Turning that isolation off in the
// TEST browser lets us click inside the frame; the sandbox attribute itself (opaque origin) is what is being verified.
(async () => {
  const h = await launch(process.env.LUMEN_URL || 'http://localhost:3101', 9346, { extraArgs: ['--disable-features=IsolateSandboxedIframes'] });
  const { ev, ok, waitFor, shot, cmd, ctxs } = h;
  const html = `<!doctype html><html><head><title>Click Counter</title><style>body{font-family:sans-serif;margin:0}#b{position:fixed;left:20px;top:20px;width:140px;height:44px;font-size:16px}#n{position:fixed;left:20px;top:90px;font-size:28px}</style></head><body>
<button id="b">Click me</button><div id="n">Clicks: 0</div>
<script>
let c=0; document.getElementById('b').onclick=()=>{c++;document.getElementById('n').textContent='Clicks: '+c};
const out=[]; const sec=document.createElement('pre'); sec.id='sec'; document.body.appendChild(sec);
try{out.push('parent.document: '+String(window.parent.document.body).slice(0,20))}catch(e){out.push('parent.document: BLOCKED')}
try{out.push('localStorage: '+localStorage.length)}catch(e){out.push('localStorage: BLOCKED')}
try{out.push('cookie: ['+document.cookie+']')}catch(e){out.push('cookie: BLOCKED')}
fetch('/api/chats').then(r=>out.push('fetch: REACHED '+r.status)).catch(e=>out.push('fetch: BLOCKED')).finally(()=>{sec.textContent=out.join(' ; ')});
</script></body></html>`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#6d5efc"/><circle cx="100" cy="60" r="30" fill="white"/></svg>';
  await ev(`state.chat.messages = [{role:'user',content:'make a counter'},{role:'assistant',content:'Here you go:\\n\\n\`\`\`html\\n' + ${JSON.stringify(html)} + '\\n\`\`\`\\n\\nAnd a logo:\\n\\n\`\`\`svg\\n' + ${JSON.stringify(svg)} + '\\n\`\`\`'}]; renderAll(); 1`);

  ok('both code blocks get an "Open as artifact" button', (await ev(`document.querySelectorAll('[data-open-art]').length`)) === 2);
  ok('panel is closed initially', (await ev(`document.querySelector('#artifact').hidden`)) === true);
  await ev(`document.querySelectorAll('[data-open-art]')[0].click(); 1`); await sleep(800);
  ok('clicking opens the panel', (await ev(`document.querySelector('#artifact').hidden`)) === false);
  ok('title comes from <title>; type and version counter shown', (await ev(`[document.getElementById('artTitle').textContent, document.getElementById('artMeta').textContent, document.getElementById('artPos').textContent].join(' | ')`)) === 'Click Counter | html | 1 / 2');
  ok('iframe is sandboxed without same-origin', (await ev(`document.querySelector('#artFrame').getAttribute('sandbox')`)) === 'allow-scripts allow-forms');

  const rect = await ev(`(() => { const r = document.querySelector('#artFrame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  for (let k = 0; k < 3; k++) { for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x + 60, y: rect.y + 42, button: 'left', clickCount: 1 }); await sleep(150); }
  await sleep(500);
  const frame = [...ctxs].reverse().find((c) => c.auxData && c.auxData.isDefault && c.origin === '://');
  ok('artifact frame has an opaque origin', !!frame, frame && frame.origin);
  if (frame) {
    ok('script inside the artifact runs and reacts to real clicks', (await ev(`document.getElementById('n').textContent`, frame.id)) === 'Clicks: 3');
    const probes = await ev(`document.getElementById('sec').textContent`, frame.id);
    ok('artifact cannot reach parent DOM, localStorage, cookies or the API', /parent\.document: BLOCKED/.test(probes) && /localStorage: BLOCKED/.test(probes) && /cookie: BLOCKED/.test(probes) && /fetch: BLOCKED/.test(probes), probes);
  }
  await shot('step2-artifact');
  await ev(`document.querySelector('#tabCode').click(); 1`); await sleep(200);
  ok('Code tab shows the source and hides the preview', (await ev(`document.querySelector('#artCode').textContent.length`)) > 100 && (await ev(`document.querySelector('#artFrame').hidden`)));
  await ev(`document.querySelector('#artNext').click(); document.querySelector('#tabPreview').click(); 1`); await sleep(500);
  ok('next version is the SVG', (await ev(`document.getElementById('artTitle').textContent + ' | ' + document.getElementById('artPos').textContent`)) === 'SVG image | 2 / 2');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 1`);
  ok('Esc closes the panel', (await ev(`document.querySelector('#artifact').hidden`)) === true);
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
