// Adaptador de LabelGrid (API pública v1). Implementa el contrato de provider.js.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import * as M from './labelgrid-mappers.js';

export class LabelGridError extends Error {
  constructor(status, message, { code = null, body = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'LabelGridError';
    this.status = status; this.code = code; this.body = body; this.retryAfter = retryAfter;
  }
}

export class LabelGridClient {
  constructor({ apiUrl, token }, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    this.apiUrl = apiUrl; this.token = token; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query, json, form, retries = method === 'GET' ? 2 : 0 } = {}) {
    if (!this.token) throw new LabelGridError(401, 'Falta LABELGRID_TOKEN en el servidor.', { code: 'no_token' });
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) body = form;

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        if (attempt < retries) { await sleep(300 * 2 ** attempt); continue; }
        throw new LabelGridError(0, `No se pudo contactar a LabelGrid: ${e.message}`, { code: 'network' });
      }
      if (res.status >= 500 && attempt < retries) { await sleep(300 * 2 ** attempt); continue; }
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
      if (!res.ok) {
        const code = data?.code ?? data?.error?.code ?? data?.error_code ?? null;
        const msg = data?.message ?? data?.error?.message ?? `LabelGrid respondió ${res.status}`;
        throw new LabelGridError(res.status, msg, { code, body: data, retryAfter: Number(res.headers.get('retry-after')) || null });
      }
      return { status: res.status, data };
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, json) { return this.request('POST', path, { json }); }
  patch(path, json) { return this.request('PATCH', path, { json }); }
  put(path, json) { return this.request('PUT', path, { json }); }
  del(path) { return this.request('DELETE', path); }

  // Recorre colecciones paginadas {data, meta:{last_page}} (labels, releases, artists, writers).
  async listAll(path, query = {}, maxPages = 20) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.get(path, { ...query, per_page: 100, page });
      const rows = Array.isArray(data) ? data : data?.data ?? [];
      out.push(...rows);
      if (Array.isArray(data) || !data?.meta || page >= data.meta.last_page) break;
    }
    return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Verificación del webhook según la documentación de LabelGrid:
// HMAC-SHA256 hexadecimal del cuerpo CRUDO, cabecera X-Webhook-Signature, y `timestamp` del
// cuerpo firmado (no la cabecera) dentro de ±5 minutos.
export function verifyLabelGridWebhook(rawBody, headers, secret, now = Date.now()) {
  if (!secret) throw new LabelGridError(500, 'Webhook sin secreto configurado.', { code: 'no_secret' });
  const sig = String(headers['x-webhook-signature'] ?? '').trim().toLowerCase().replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new LabelGridError(401, 'Firma de webhook inválida.', { code: 'bad_signature' });
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new LabelGridError(400, 'Webhook con JSON inválido.', { code: 'bad_json' }); }
  const ts = typeof body.timestamp === 'number' ? body.timestamp * (body.timestamp < 1e12 ? 1000 : 1) : Date.parse(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60_000) throw new LabelGridError(401, 'Webhook fuera de ventana de tiempo (5 min).', { code: 'stale' });
  const ids = Object.entries(body.data ?? {}).filter(([k, v]) => /(^|_)id$/.test(k) && v != null).map(([k, v]) => `${k}=${v}`).sort();
  return { event: body.event, webhookId: body.webhook_id, data: body.data ?? {}, timestamp: ts, key: `${body.event}|${ids.join('&')}` };
}

export class LabelGridProvider {
  name = 'labelgrid';

  constructor(cfg, { fetchImpl, cache, uploadPollMs = 2000, uploadTimeoutMs = 10 * 60_000 } = {}) {
    this.cfg = cfg;
    this.api = new LabelGridClient(cfg, { fetchImpl });
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.cache = cache ?? makeMemoryCache();
    this.uploadPollMs = uploadPollMs; this.uploadTimeoutMs = uploadTimeoutMs;
  }

  async getAccount() {
    const { data } = await this.api.get('/me');
    const u = data?.data ?? data ?? {};
    return { name: u.name ?? u.full_name ?? u.username ?? null, email: u.email ?? null };
  }

  async getCatalog() {
    const [labels, genres, outlets] = await Promise.all([
      this.api.listAll('/labels'),
      this.api.get('/genres').then((r) => r.data),
      this.api.get('/distro-outlets').then((r) => r.data),
    ]);
    return {
      labels: labels.map((l) => ({ id: l.id, name: l.name })),
      genres: genres.map((g) => ({ id: g.id, name: g.name, category: g.category ?? null })),
      outlets: outlets.filter((o) => !o.is_ugc_store).map((o) => ({ id: o.id, key: o.key, name: o.name, type: o.type })),
    };
  }

  // --- Entidades auxiliares (artistas, autores): se buscan antes de crear para no duplicar ---

  async ensureArtist(name) {
    const key = name.trim().toLowerCase();
    const hit = this.cache.get(`artist:${key}`);
    if (hit) return hit;
    const existing = (await this.api.listAll('/artists')).find((a) => (a.artist_name ?? '').trim().toLowerCase() === key);
    const id = existing?.id ?? (await this.api.post('/artists', M.toArtistCreate(name))).data?.id;
    if (!id) throw new LabelGridError(502, `LabelGrid no devolvió id para el artista "${name}".`, { code: 'no_id' });
    this.cache.set(`artist:${key}`, id);
    return id;
  }

  async ensureWriter(w) {
    const key = M.writerKey(w);
    const hit = this.cache.get(`writer:${key}`);
    if (hit) return hit;
    const norm = (s) => (s ?? '').trim().toLowerCase();
    const existing = (await this.api.listAll('/writers')).find((x) => `${norm(x.first_name)}|${norm(x.last_name)}` === key);
    const id = existing?.id ?? (await this.api.post('/writers', M.toWriterCreate(w))).data?.id;
    if (!id) throw new LabelGridError(502, `LabelGrid no devolvió id para el autor "${w.lastName}".`, { code: 'no_id' });
    this.cache.set(`writer:${key}`, id);
    return id;
  }

  // --- Sincronización del borrador remoto ---

  async syncRelease(release) {
    const names = new Set([...release.artists, ...release.tracks.flatMap((t) => t.artists)].map((a) => a.name.trim()));
    const artistIds = {};
    for (const n of names) artistIds[n.toLowerCase()] = await this.ensureArtist(n);

    const prev = release.provider ?? {};
    let providerReleaseId = prev.releaseId;
    if (providerReleaseId) {
      await this.api.patch(`/releases/${providerReleaseId}`, M.toReleasePatch(release, { artistIds }));
    } else {
      const { data } = await this.api.post('/releases', M.toReleaseCreate(release, { artistIds }));
      providerReleaseId = data?.id ?? data?.data?.id;
      if (!providerReleaseId) throw new LabelGridError(502, 'LabelGrid no devolvió el id del release.', { code: 'no_id' });
    }

    const trackIds = { ...(prev.trackIds ?? {}) };
    const writerIds = {};
    for (const t of release.tracks) for (const w of t.writers) writerIds[M.writerKey(w)] = await this.ensureWriter(w);

    for (const t of release.tracks) {
      const body = M.toTrackCreate(t, { providerReleaseId, artistIds, writerIds });
      if (trackIds[t.id]) {
        const { release_id, ...patch } = body;
        await this.api.patch(`/tracks/${trackIds[t.id]}`, patch);
      } else {
        const { data } = await this.api.post('/tracks', body);
        trackIds[t.id] = data?.id ?? data?.data?.id;
        if (!trackIds[t.id]) throw new LabelGridError(502, `LabelGrid no devolvió id para la pista "${t.title}".`, { code: 'no_id' });
      }
    }
    // Pistas eliminadas en el portal -> borrar en remoto
    const keep = new Set(release.tracks.map((t) => t.id));
    for (const [localId, remoteId] of Object.entries(trackIds)) {
      if (!keep.has(localId)) { await this.api.del(`/tracks/${remoteId}`); delete trackIds[localId]; }
    }
    return { providerReleaseId: String(providerReleaseId), trackIds };
  }

  // --- Subida de archivos ---

  async uploadAssets(release, files) {
    const { releaseId, trackIds } = release.provider;
    const cover = files.cover();
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(cover.path)]), cover.filename);
    await this.api.request('POST', `/releases/${releaseId}/photo`, { form });

    for (const t of release.tracks) {
      const f0 = files.audio(t);
      if (!f0) continue;
      const f = { ...f0, size: fs.statSync(f0.path).size }; // tamaño real en disco, no el guardado
      if (t.audio?.uploadedKey === `${f.size}:${f.filename}`) continue;
      const trackId = trackIds[t.id];
      const { data: up } = await this.api.post(`/tracks/${trackId}/files/stereo/upload-url`, { filename: f.filename });
      const put = await this.fetch(up.upload_url, {
        method: 'PUT', body: Readable.toWeb(fs.createReadStream(f.path)), duplex: 'half',
        headers: { 'content-length': String(f.size) }, signal: AbortSignal.timeout(this.uploadTimeoutMs),
      });
      if (!put.ok) throw new LabelGridError(put.status, `Falló la subida de "${f.filename}" al almacenamiento.`, { code: 'upload_failed' });
      const reg = await this.api.put(`/tracks/${trackId}/files/stereo`, { s3_key: up.key });
      if (reg.status === 202) await this.#waitUpload(trackId, reg.data?.upload_attempt ?? reg.data);
      t.audio.uploadedKey = `${f.size}:${f.filename}`;
    }
    return { ok: true };
  }

  async #waitUpload(trackId, attempt) {
    const started = Date.now();
    let a = attempt;
    for (;;) {
      const st = String(a?.status ?? '').toLowerCase(); // SUPUESTO: valores de status
      if (/complete|success|done|ready|processed/.test(st)) return;
      if (/fail|error|reject/.test(st)) throw new LabelGridError(422, `LabelGrid rechazó el audio: ${a.error ?? a.message ?? st}`, { code: 'audio_rejected', body: a });
      if (Date.now() - started > this.uploadTimeoutMs) throw new LabelGridError(504, 'Tiempo agotado procesando el audio.', { code: 'upload_timeout' });
      await sleep(Math.max(0, (a?.poll_after_seconds ?? 0) * 1000) || this.uploadPollMs);
      a = (await this.api.get(`/tracks/${trackId}/file-upload-attempts/${attempt.id}`)).data;
      a = a?.upload_attempt ?? a?.data ?? a;
    }
  }

  // --- Validación, entrega, estado, baja ---

  async validate(release) {
    try { return M.fromValidate((await this.api.post(`/releases/${release.provider.releaseId}/validate`)).data); }
    catch (e) {
      if (e instanceof LabelGridError && e.status === 422 && e.body) return M.fromValidate(e.body);
      throw e;
    }
  }

  async distribute(release) {
    const { data } = await this.api.post(`/releases/${release.provider.releaseId}/distribute`);
    return { status: data?.status ?? 'submitted', message: data?.message ?? null };
  }

  async getDeliveryStatus(release) {
    return M.fromDeliveryStatus((await this.api.get(`/releases/${release.provider.releaseId}/delivery-status`)).data);
  }

  async takedown(release, { message, confirmContractHold = false } = {}) {
    const body = {};
    if (message) body.message = message.slice(0, 255);
    if (confirmContractHold) body.confirm_contract_hold = true;
    const { data } = await this.api.post(`/releases/${release.provider.releaseId}/takedown-all`, body);
    return { message: data?.message ?? 'Baja solicitada' };
  }

  // --- Regalías ---

  async listStatements({ releaseId, from, to } = {}) {
    const query = { 'filter[release_id]': releaseId, 'filter[start_date]': from, 'filter[end_date]': to };
    const { data } = await this.api.get('/statements', query);
    return (data?.data ?? []).map(M.fromStatement);
  }

  async getBreakdown({ groupBy = 'dsp', releaseId, from, to, maxPages = 10 } = {}) {
    const rows = []; let cursor; let total = 0;
    for (let i = 0; i < maxPages; i++) {
      const { data } = await this.api.get('/royalties/breakdown', {
        group_by: groupBy, per_page: 500, cursor,
        'filter[release_id]': releaseId, 'filter[start_date]': from, 'filter[end_date]': to,
      });
      rows.push(...(data?.data ?? []).map(M.fromBreakdownRow));
      total = data?.meta?.total_gross_usd ?? total;
      cursor = data?.meta?.next_cursor;
      if (!cursor) break;
    }
    return { rows, totalGrossUsd: total };
  }

  verifyWebhook(rawBody, headers) { return verifyLabelGridWebhook(rawBody, headers, this.cfg.webhookSecret); }
}

function makeMemoryCache() { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; }
