// Requests to the stores, on Node's own http/https client.
//
// Node's built-in fetch() is refused by some stores' CDNs (Target answers it
// with 403 and JB Hi-Fi with 429) while the same request with the same honest
// headers from node:https is answered normally. So store pages are fetched
// here instead. It answers like fetch() (status, ok, url, headers, text(),
// json()) and never follows redirects itself: safeFetch() checks each hop.
//
// Connections are kept open between requests, so a sweep every few seconds
// doesn't pay for a new TLS handshake each time.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4, timeout: 30000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 30000 }),
};

const MAX_BYTES = 6 * 1024 * 1024;

function decoder(encoding) {
  switch (String(encoding || '').toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    default: return null;
  }
}

class StoreResponse {
  constructor(status, url, headers, body) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  async text() { return this.body.toString('utf8'); }
  async json() { return JSON.parse(this.body.toString('utf8')); }
}

/** fetch(url, { method, headers, signal, timeoutMs, maxBytes }) on node:http(s). */
export function storeFetch(url, init = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
  if (!lib) return Promise.reject(new TypeError(`Can't fetch ${u.protocol} links`));
  const headers = { 'accept-encoding': 'gzip, deflate, br', ...(init.headers || {}) };
  const maxBytes = init.maxBytes || MAX_BYTES;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; cleanup(); fn(v); } };
    const req = lib.request(u, { method: init.method || 'GET', headers, agent: agents[u.protocol] }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
        else if (v !== undefined) out.set(k, String(v));
      }
      const unzip = decoder(res.headers['content-encoding']);
      const stream = unzip ? res.pipe(unzip) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); stream.destroy(); finish(resolve, new StoreResponse(res.statusCode, url, out, Buffer.concat(chunks))); return; }
        chunks.push(c);
      });
      stream.on('end', () => finish(resolve, new StoreResponse(res.statusCode, url, out, Buffer.concat(chunks))));
      stream.on('error', (e) => finish(reject, e));
    });
    const timer = init.timeoutMs ? setTimeout(() => { const e = new Error('The store took too long to answer'); e.name = 'TimeoutError'; req.destroy(e); finish(reject, e); }, init.timeoutMs) : null;
    const onAbort = () => { const e = init.signal.reason || new Error('Aborted'); req.destroy(e); finish(reject, e); };
    if (init.signal) {
      if (init.signal.aborted) { onAbort(); return; }
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (init.signal) init.signal.removeEventListener('abort', onAbort);
    }
    req.on('error', (e) => finish(reject, e));
    if (init.body) req.write(init.body);
    req.end();
  });
}
