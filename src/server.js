import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigFromProcess } from './config.js';
import { Store } from './store.js';
import { createProvider } from './providers/provider.js';
import { ReleaseService, friendly } from './services/releases.js';
import { RoyaltyService } from './services/royalties.js';
import { WebhookService } from './services/webhooks.js';
import { HttpError, readBody, readJson, sendJson, serveStatic } from './http-utils.js';

export function createApp({ config, store, provider, poll = true }) {
  const releases = new ReleaseService({ store, provider, config });
  const royalties = new RoyaltyService({ store, provider });
  const webhooks = new WebhookService({ store, provider, releases });
  let catalogCache = null;

  const catalog = async () => {
    if (!catalogCache || Date.now() - catalogCache.at > 10 * 60_000) catalogCache = { at: Date.now(), value: await provider.getCatalog() };
    return catalogCache.value;
  };

  const routes = [
    ['GET', '/api/health', async () => ({ ok: true, provider: provider.name })],
    ['GET', '/api/account', async () => ({ provider: provider.name, ...(await provider.getAccount()) })],
    ['GET', '/api/catalog', catalog],
    ['GET', '/api/releases', async () => releases.list()],
    ['POST', '/api/releases', async ({ req }) => [201, releases.create(await readJson(req))]],
    ['GET', '/api/releases/:id', async ({ p }) => releases.get(p.id)],
    ['PUT', '/api/releases/:id', async ({ p, req }) => releases.update(p.id, await readJson(req))],
    ['DELETE', '/api/releases/:id', async ({ p }) => { releases.remove(p.id); return { ok: true }; }],
    ['POST', '/api/releases/:id/precheck', async ({ p }) => releases.precheck(p.id)],
    ['PUT', '/api/releases/:id/cover', async ({ p, req, q }) => releases.saveCover(p.id, q.get('filename') ?? 'cover.jpg', req)],
    ['PUT', '/api/releases/:id/tracks/:tid/audio', async ({ p, req, q }) => releases.saveAudio(p.id, p.tid, q.get('filename') ?? 'audio.wav', req)],
    ['POST', '/api/releases/:id/submit', async ({ p }) => releases.submit(p.id)],
    ['POST', '/api/releases/:id/refresh', async ({ p }) => releases.refreshStatus(p.id)],
    ['POST', '/api/releases/:id/takedown', async ({ p, req }) => releases.takedown(p.id, await readJson(req))],
    ['GET', '/api/royalties/statements', async ({ q }) => royalties.statements({ from: q.get('from') ?? undefined, to: q.get('to') ?? undefined })],
    ['GET', '/api/royalties/breakdown', async ({ q }) => royalties.breakdown({ groupBy: q.get('groupBy') ?? 'dsp', from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, releaseId: q.get('releaseId') ?? undefined })],
  ].map(([method, pattern, fn]) => ({ method, fn, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') }));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Webhook: cuerpo CRUDO para verificar la firma; sin CORS ni cookies.
      if (req.method === 'POST' && url.pathname === '/api/webhooks/labelgrid') {
        const raw = await readBody(req, 1024 * 1024);
        const out = await webhooks.handle(raw, req.headers);
        return sendJson(res, 200, out);
      }

      if (url.pathname.startsWith('/api/')) {
        // Defensa CSRF básica: una página ajena no puede disparar acciones en tu portal local.
        if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido');

        const cover = url.pathname.match(/^\/api\/releases\/([^/]+)\/cover$/);
        if (req.method === 'GET' && cover) {
          const r = releases.get(cover[1]);
          if (!r.cover?.path || !fs.existsSync(r.cover.path)) throw new HttpError(404, 'Sin portada');
          res.writeHead(200, { 'content-type': /\.png$/i.test(r.cover.filename) ? 'image/png' : 'image/jpeg', 'cache-control': 'no-cache' });
          return fs.createReadStream(r.cover.path).pipe(res);
        }

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const out = await r.fn({ req, p: m.groups ?? {}, q: url.searchParams });
          return Array.isArray(out) && typeof out[0] === 'number' ? sendJson(res, out[0], out[1]) : sendJson(res, 200, redact(out));
        }
        throw new HttpError(404, 'Ruta no encontrada');
      }

      if (req.method === 'GET' && serveStatic(res, config.publicDir, url.pathname)) return;
      throw new HttpError(404, 'No encontrado');
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? 'Error interno' : friendly(e), code: e.code ?? null, details: e.details ?? null });
    }
  });

  let timer = null;
  server.on('listening', () => { if (poll) timer = setInterval(() => releases.refreshAll().catch(() => {}), 15_000); timer?.unref(); });
  server.on('close', () => clearInterval(timer));
  return { server, releases, royalties, webhooks };
}

// Las rutas de lectura nunca devuelven rutas del disco del servidor.
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) if (k !== 'path') o[k] = redact(val);
    return o;
  }
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfigFromProcess();
  const store = new Store(config.dataFile);
  const cache = { get: (k) => store.getSetting(`lg:${k}`), set: (k, v) => store.setSetting(`lg:${k}`, v) };
  const provider = createProvider(config, { cache });
  const { server } = createApp({ config, store, provider });
  server.listen(config.port, config.host, () => {
    console.log(`Portal en http://${config.host}:${config.port}  ·  proveedor: ${provider.name}`);
    if (provider.name === 'labelgrid' && !config.labelgrid.token) console.warn('⚠ Falta LABELGRID_TOKEN: las llamadas fallarán hasta configurarlo.');
  });
}
