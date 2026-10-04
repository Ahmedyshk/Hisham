#!/usr/bin/env node
/**
 * Zero-dependency static preview server — `npm start`.
 *
 * Mirrors GitHub Pages closely enough for local QA: directory index files,
 * a 404.html fallback, and correct MIME types (including .webmanifest and
 * .woff2). Nothing here is used in production; the deployed site is just files.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function resolveTarget(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }

  const target = path.normalize(path.join(ROOT, decoded));
  // Refuse anything that escapes the project directory.
  if (!target.startsWith(ROOT)) return null;

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(target) ? target : null;
}

const server = http.createServer((req, res) => {
  const file = resolveTarget(req.url || '/');

  if (!file) {
    const fallback = path.join(ROOT, '404.html');
    if (fs.existsSync(fallback)) {
      const body = fs.readFileSync(fallback);
      res.writeHead(404, { 'content-type': TYPES['.html'], 'content-length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': TYPES['.txt'] });
    res.end('404');
    return;
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  دفرنة في القدرات والتحصيلي — preview\n`);
  console.log(`  http://${HOST}:${PORT}/\n`);
  console.log(`  serving ${ROOT}`);
  console.log(`  press Ctrl+C to stop\n`);
});
