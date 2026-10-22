// Fake SearXNG: returns canned JSON results and records the last query.
const http = require('http');
const fs = require('fs');
fs.mkdirSync(process.env.LUMEN_TEST_TMP || require('os').tmpdir() + '/lumen-tests', { recursive: true });
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/search') {
    fs.writeFileSync(require('path').join(process.env.LUMEN_TEST_TMP || require('os').tmpdir() + '/lumen-tests', 'searx-last-query.txt'), u.searchParams.get('q') + '|' + u.searchParams.get('format'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ results: [
      { title: 'Lumen Zebra Handbook', url: 'https://example.org/zebra', content: 'The official handbook about zebra stripes and the Lumen office.' },
      { title: 'Zebra Facts', url: 'https://example.org/facts', content: 'Zebras are African equids.' },
    ] }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Local page</title></head><body>secret local content</body></html>');
}).listen(3197, '127.0.0.1', () => console.log('fake searxng on 3197'));
