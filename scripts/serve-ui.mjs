#!/usr/bin/env node
// Serve the built Impri web inbox and proxy the API on one origin — a
// docker/nginx-free way to self-host the UI. The SPA calls `/v1` relatively,
// so serving it same-origin with API proxying avoids CORS entirely.
//
//   UI_DIST     path to built UI (default ../ui/dist)
//   IMPRI_API   API base to proxy /v1 and /healthz to (default http://127.0.0.1:8484)
//   UI_PORT     listen port (default 8080)
//   UI_HOST     listen host (default 127.0.0.1)

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = process.env.UI_DIST ?? fileURLToPath(new URL('../ui/dist', import.meta.url));
const API = (process.env.IMPRI_API ?? 'http://127.0.0.1:8484').replace(/\/$/, '');
const PORT = Number(process.env.UI_PORT ?? 8080);
const HOST = process.env.UI_HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function isApiPath(url) {
  return url === '/healthz' || url === '/v1' || url.startsWith('/v1/');
}

const server = http.createServer((req, res) => {
  if (isApiPath(req.url)) {
    const target = new URL(req.url, API);
    const preq = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (pres) => { res.writeHead(pres.statusCode ?? 502, pres.headers); pres.pipe(res); },
    );
    preq.on('error', () => { res.writeHead(502); res.end('API proxy error'); });
    req.pipe(preq);
    return;
  }

  // Static file, else SPA fallback to index.html
  let rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (rel === '/') rel = '/index.html';
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => console.log(`Impri UI on http://${HOST}:${PORT} → API ${API}`));
