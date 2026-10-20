// Built-in web tools for the model: fetch_page (public pages only) and web_search (SearXNG or Brave).
// Everything returned here is untrusted text from the internet; calls still need the user's approval.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const MAX_BYTES = 500 * 1024;
const MAX_TEXT = 12000;
const TIMEOUT = 10000;

// True for loopback, private, link-local, CGNAT, multicast and other non-public addresses.
function isPrivateIp(ip) {
  ip = String(ip).toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return true; // not an IP at all: refuse
}

// Validates the address actually connected to, so DNS rebinding between check and connect cannot help.
function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('Blocked: that address is private or local'));
    return opts && opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

function getOnce(u) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('Blocked: that address is private or local'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: host, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', lookup: safeLookup, timeout: TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumen/1.0)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u).href }); }
      const type = String(res.headers['content-type'] || '');
      if (!/^(text\/|application\/(json|xml|xhtml))/i.test(type)) { res.resume(); return reject(new Error(`Unsupported content type: ${type || 'unknown'}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { res.destroy(); } else chunks.push(c); });
      const done = () => resolve({ status: res.statusCode, type, body: Buffer.concat(chunks).toString('utf8') });
      res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end();
  });
}

const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const t = decode(html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
  return { title: title ? decode(title).replace(/\s+/g, ' ').trim() : '', text: t };
}

async function fetchPage(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched');
  for (let hop = 0; hop < 4; hop++) {
    const r = await getOnce(u);
    if (r.redirect) { u = new URL(r.redirect); if (!/^https?:$/.test(u.protocol)) throw new Error('Redirected to an unsupported URL'); continue; }
    const isHtml = /html/i.test(r.type);
    const { title, text } = isHtml ? htmlToText(r.body) : { title: '', text: r.body.trim() };
    let out = `URL: ${u.href}\n${title ? 'Title: ' + title + '\n' : ''}Status: ${r.status}\n\n${text}`;
    if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT) + `\n…[truncated]`;
    return out;
  }
  throw new Error('Too many redirects');
}

async function webSearch(query, web) {
  const q = String(query || '').trim();
  if (!q) throw new Error('A search query is required');
  let results;
  if (web.provider === 'searxng' && web.searxngUrl) {
    const r = await fetch(`${web.searxngUrl.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`SearXNG returned ${r.status}${r.status === 403 ? ' (enable the json format in its settings)' : ''}`);
    results = ((await r.json()).results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
  } else if (web.provider === 'brave' && web.braveKey) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: 'application/json', 'X-Subscription-Token': web.braveKey } });
    if (!r.ok) throw new Error(`Brave Search returned ${r.status}`);
    results = (((await r.json()).web || {}).results || []).map((x) => ({ title: x.title, url: x.url, snippet: String(x.description || '').replace(/<[^>]+>/g, '') }));
  } else throw new Error('No search provider is configured');
  results = results.slice(0, 8);
  if (!results.length) return 'No results.';
  return results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${String(x.snippet || '').slice(0, 300)}`).join('\n\n');
}

const str = (description) => ({ type: 'string', description });
function tools(web) {
  const list = [{ name: 'fetch_page', description: 'Fetch a public web page (http/https) and return its readable text.', inputSchema: { type: 'object', properties: { url: str('The full URL to fetch') }, required: ['url'] } }];
  if (web.provider === 'searxng' ? web.searxngUrl : web.provider === 'brave' ? web.braveKey : false)
    list.unshift({ name: 'web_search', description: 'Search the web and return the top results (title, URL, snippet).', inputSchema: { type: 'object', properties: { query: str('What to search for') }, required: ['query'] } });
  return list;
}

async function call(tool, args, web) {
  try {
    if (tool === 'fetch_page') return { isError: false, text: await fetchPage(args && args.url) };
    if (tool === 'web_search') return { isError: false, text: await webSearch(args && args.query, web) };
    return { isError: true, text: `Unknown tool: ${tool}` };
  } catch (e) { return { isError: true, text: String(e.message || e).slice(0, 500) }; }
}

module.exports = { tools, call, isPrivateIp, htmlToText };
