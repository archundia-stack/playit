import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

export function safeFilename(name) {
  const base = path.basename(String(name || 'archivo')).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return base || 'archivo';
}

// Guarda el cuerpo de la petición en disco en streaming, con tope de tamaño.
export async function streamToFile(req, dest, maxBytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new HttpError(413, 'Archivo demasiado grande')); }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) { out.destroy(); fs.rmSync(dest, { force: true }); throw e; }
  return size;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

export function serveStatic(res, root, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let file = path.resolve(root, rel);
  // Índice de carpeta: / sirve la landing y /portal sirve el portal.
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}
