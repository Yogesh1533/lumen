// Child process for the harness test: launches a headless browser and stays alive.
// The parent sends SIGINT to check that the browser is stopped with it.
const { launch } = require('./cdplib');
(async () => {
  await launch(process.argv[2], Number(process.argv[3]), {});
  console.log('READY');
  setInterval(() => {}, 1000);
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
