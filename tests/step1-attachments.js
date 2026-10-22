const path = require('path');
const { launch, sleep } = require('./lib/cdplib');
const FX = path.join(__dirname, 'fixtures');

(async () => {
  const h = await launch(process.env.LUMEN_URL || 'http://localhost:3101', 9345);
  const { ev, ok, waitFor, shot } = h;
  await ev(`document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster

  // Attach an image, a text file and a PDF through the real file input.
  await h.setFiles('#fileInput', ['red.png', 'notes.txt', 'vault.pdf'].map((f) => path.join(FX, f)));
  ok('3 attachment chips appear', await waitFor(`state.pending.length === 3`, 15000), await ev(`[...document.querySelectorAll('#chips .chip')].map(c => c.innerText.replace(/\\n/g, ' | ')).join(' || ')`));
  ok('image is stored as an image, files as text', (await ev(`state.pending.map(a => a.kind).join()`)) === 'image,text,text');
  ok('PDF text was extracted', /BLUEFISH-7/.test(await ev(`state.pending[2].text`)));
  const model = await ev(`state.models.find(m => m.caps.includes('vision')) && state.models.find(m => m.caps.includes('vision')).id`);
  ok('a vision-capable model exists', !!model, model);
  await ev(`document.querySelector('#modelSelect').value = ${JSON.stringify(model)}; 1`);

  const reply = await h.ask('Answer in one line: what colour is the image, what is the launch codeword in the text file, and what is the vault password in the PDF?');
  console.log('   answer:', JSON.stringify(reply));
  ok('model saw the IMAGE (red)', /red/i.test(reply));
  ok('model read the TEXT file (PINEAPPLE-42)', /PINEAPPLE-42/.test(reply));
  ok('model read the PDF (BLUEFISH-7)', /BLUEFISH-7/.test(reply));
  ok('user message shows a thumbnail and file cards', (await ev(`!!document.querySelector('.msg.user .att img')`)) && (await ev(`document.querySelectorAll('.msg.user .att.file').length`)) === 2);
  ok('composer chips cleared after sending', (await ev(`state.pending.length`)) === 0);

  // A model without vision must be refused instead of silently dropping the image.
  const noVision = await ev(`(state.models.find(m => !m.caps.includes('vision')) || {}).id || ''`);
  if (noVision) {
    await ev(`newChat(); document.querySelector('#modelSelect').value = ${JSON.stringify(noVision)}; 1`);
    await h.setFiles('#fileInput', [path.join(FX, 'red.png')]); await waitFor(`state.pending.length === 1`, 10000);
    await ev(`send('what is this?'); 1`); await sleep(800);
    ok('image + non-vision model is blocked with a warning', (await ev(`state.chat.messages.length`)) === 0 && /can't see images/.test(await ev(`document.querySelector('#toast').textContent`)));
  } else console.log('SKIP non-vision model check (every installed model has vision)');
  await shot('step1-attachments');
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
