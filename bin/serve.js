#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVED_DIRS = ['viewer', 'src'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '8080' },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid --port value: ${values.port}`);
  process.exit(2);
}

function resolvePath(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath)).replace(/^[/\\]+/, '');
  const [top] = rel.split(sep);
  if (!SERVED_DIRS.includes(top) || !(extname(rel) in TYPES)) return null;
  return join(ROOT, rel);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/' || pathname === '/viewer') {
    res.writeHead(302, { Location: '/viewer/' }).end();
    return;
  }
  const path = resolvePath(pathname);
  if (path === null) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)], 'Cache-Control': 'no-store' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not found');
    else {
      console.error(`serve: ${path}: ${err.message}`);
      res.writeHead(500).end('Server error');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Battery stats viewer: http://localhost:${server.address().port}/viewer/`);
});
