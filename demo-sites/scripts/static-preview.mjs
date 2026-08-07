import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || process.env.PORT || 4400);
const host = process.argv[4] || process.env.HOST || '127.0.0.1';

const server = createServer(async (request, response) => {
  try {
    const filePath = await resolveRequestPath(request.url || '/');
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': contentType(filePath)
    });
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
      'content-type': 'text/plain; charset=utf-8'
    });
    response.end(error.code === 'ENOENT' ? 'Not found' : error.message);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`static preview listening at http://${host}:${port}/\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

async function resolveRequestPath(url) {
  const parsed = new URL(url, `http://${host}:${port}`);
  const decoded = decodeURIComponent(parsed.pathname);
  const safePath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const candidate = path.join(root, safePath);
  const target = await resolveIndex(candidate);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Refusing to serve outside preview root');
    error.code = 'EACCES';
    throw error;
  }
  return target;
}

async function resolveIndex(filePath) {
  const fileStat = await stat(filePath);
  if (fileStat.isDirectory()) return path.join(filePath, 'index.html');
  return filePath;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
