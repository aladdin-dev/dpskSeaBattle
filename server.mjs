/* Простой статический сервер без зависимостей — только для локальной разработки. */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function safePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  const relative = normalize(pathname).replace(/^([/\\])+/, '');
  const target = resolve(join(ROOT, relative || 'index.html'));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = http.createServer((req, res) => {
  if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let target = safePath(req.url);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html');
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — файл не найден');
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Ошибка чтения файла');
    })
    .pipe(res);
});

server.listen(PORT, HOST, () => {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  console.log('');
  console.log('  Морской бой — локальный сервер');
  console.log('  ---------------------------------');
  console.log(`  http://localhost:${PORT}`);
  for (const address of addresses) console.log(`  http://${address}:${PORT}`);
  console.log('');
  console.log('  Для игры с телефона по сети нужен HTTPS-хостинг.');
  console.log('  Подробности — в README.md.');
  console.log('');
});

server.on('error', (error) => {
  console.error('Не удалось запустить сервер:', error.message);
  process.exitCode = 1;
});
