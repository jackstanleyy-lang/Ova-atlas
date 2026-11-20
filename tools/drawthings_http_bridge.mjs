#!/usr/bin/env node
// OVA Atlas optional bridge for the Draw Things HTTP API (computer only).
//
// Why it exists: Draw Things' HTTP API server answers /sdapi/v1/img2img but sends
// no CORS headers and has no OPTIONS route, so a browser page (including the
// GitHub Pages copy of OVA Atlas) cannot read its responses directly. This bridge
// runs on the SAME computer as Draw Things, listens only on 127.0.0.1, accepts
// requests only from the OVA Atlas origin, and forwards two routes unchanged.
// It never stores images, never logs prompts, and never contacts the internet.
//
// Usage:  node tools/drawthings_http_bridge.mjs [--port 7861] [--upstream http://127.0.0.1:7860]
//                                               [--origin https://jackstanleyy-lang.github.io]
// In Draw Things: Settings › API Server › HTTP, port 7860, then start the server.
import http from 'node:http';

export function createBridge({ upstream = 'http://127.0.0.1:7860', origins = ['https://jackstanleyy-lang.github.io'], maxBody = 96 * 1024 * 1024 } = {}) {
  const up = new URL(upstream);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(up.hostname) || up.protocol !== 'http:')
    throw new Error('Upstream must be Draw Things on this computer (http://127.0.0.1:port)');
  const allowed = new Set(origins);
  return http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const cors = allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', ...(cors || {}) }); res.end(JSON.stringify(body)); };
    if (!cors) return send(403, { error: 'Origin not allowed by the OVA Atlas bridge' });
    const route = req.url === '/sdapi/v1/img2img' && (req.method === 'POST' || req.method === 'OPTIONS')
      || req.url === '/' && (req.method === 'GET' || req.method === 'OPTIONS');
    if (!route) return send(404, { error: 'Only POST /sdapi/v1/img2img and GET / are forwarded' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', c => { if (tooBig) return; size += c.length; if (size > maxBody) { tooBig = true; send(413, { error: 'Request too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return;
      const body = Buffer.concat(chunks);
      const forward = http.request({ hostname: up.hostname.replace(/^\[|\]$/g, ''), port: up.port || 80, path: req.url, method: req.method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, upRes => {
        res.writeHead(upRes.statusCode || 502, { 'Content-Type': upRes.headers['content-type'] || 'application/json', ...cors });
        upRes.pipe(res);
      });
      forward.on('error', () => send(502, { error: 'Draw Things HTTP API server is not running on ' + up.host }));
      forward.end(body);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const port = Number(arg('--port', '7861'));
  const server = createBridge({ upstream: arg('--upstream', 'http://127.0.0.1:7860'), origins: [arg('--origin', 'https://jackstanleyy-lang.github.io')] });
  server.listen(port, '127.0.0.1', () => console.log(`OVA Atlas bridge on http://127.0.0.1:${port} → Draw Things (local only)`));
}
