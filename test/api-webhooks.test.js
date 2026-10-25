import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { MockProvider, MOCK_WEBHOOK_SECRET } from '../src/providers/mock.js';
import { verifyLabelGridWebhook } from '../src/providers/labelgrid.js';
import { sampleRelease } from './fixtures.js';

async function boot(t, providerOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const config = loadConfig({ DATA_FILE: path.join(dir, 'db.json'), UPLOAD_DIR: path.join(dir, 'up'), PROVIDER: 'mock' });
  const store = new Store(config.dataFile);
  let clock = Date.now();
  const provider = new MockProvider({ now: () => clock, ...providerOpts });
  const app = createApp({ config, store, provider, poll: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, base, store, advance: (ms) => (clock += ms), app, provider };
}

const input = () => { const r = sampleRelease(); delete r.id; delete r.cover; r.tracks[0].audio = null; return r; };

async function createReady(call) {
  const c = await call('POST', '/api/releases', input());
  assert.equal(c.status, 201);
  const id = c.json.id;
  assert.equal((await call('PUT', `/api/releases/${id}/cover?filename=p.png`, new Uint8Array(100))).status, 200);
  assert.equal((await call('PUT', `/api/releases/${id}/tracks/${c.json.tracks[0].id}/audio?filename=a.wav`, new Uint8Array(5000))).status, 200);
  return id;
}

test('API: crear → subir archivos → precheck → enviar → estado avanza hasta en vivo', async (t) => {
  const { call, advance } = await boot(t);
  const id = await createReady(call);
  assert.equal((await call('POST', `/api/releases/${id}/precheck`)).json.ok, true);
  const sent = await call('POST', `/api/releases/${id}/submit`);
  assert.equal(sent.status, 200); assert.equal(sent.json.status, 'processing');
  assert.equal((await call('POST', `/api/releases/${id}/refresh`)).json.status, 'processing');
  advance(60_000);
  const live = await call('POST', `/api/releases/${id}/refresh`);
  assert.equal(live.json.status, 'live');
  assert.ok(live.json.delivery.outlets.every((o) => o.state === 'live'));
});

test('API: tras enviar, datos y audio quedan bloqueados (409)', async (t) => {
  const { call } = await boot(t);
  const id = await createReady(call);
  await call('POST', `/api/releases/${id}/submit`);
  assert.equal((await call('PUT', `/api/releases/${id}`, input())).status, 409);
  assert.equal((await call('DELETE', `/api/releases/${id}`)).status, 409);
});

test('API: enviar con errores locales devuelve 422 con detalle y no llama al proveedor', async (t) => {
  const { call } = await boot(t);
  const c = await call('POST', '/api/releases', { ...input(), cat: '' });
  const r = await call('POST', `/api/releases/${c.json.id}/submit`);
  assert.equal(r.status, 422); assert.ok(r.json.details.errors.some((e) => e.field === 'cat'));
});

test('API: no expone rutas del disco ni acepta orígenes ajenos', async (t) => {
  const { call } = await boot(t);
  const id = await createReady(call);
  const r = await call('GET', `/api/releases/${id}`);
  assert.ok(!JSON.stringify(r.json).includes(os.tmpdir()));
  assert.equal((await call('POST', '/api/releases', input(), { origin: 'https://evil.example' })).status, 403);
});

test('API: archivos con extensión no permitida se rechazan', async (t) => {
  const { call } = await boot(t);
  const c = await call('POST', '/api/releases', input());
  assert.equal((await call('PUT', `/api/releases/${c.json.id}/cover?filename=x.exe`, new Uint8Array(10))).status, 415);
});

// ---- Webhooks ----
const signed = (body, secret = MOCK_WEBHOOK_SECRET) => {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, headers: { 'x-webhook-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') } };
};

test('webhook: firma válida actualiza el release; el reintento (mismo evento) se ignora', async (t) => {
  const { call, advance, store } = await boot(t);
  const id = await createReady(call);
  await call('POST', `/api/releases/${id}/submit`);
  advance(60_000);
  const providerId = store.getRelease(id).provider.releaseId;
  const evt = { event: 'delivery.completed', timestamp: Math.floor(Date.now() / 1000), webhook_id: 9, data: { release_id: Number(providerId), distro_queue_id: 55 } };
  const { raw, headers } = signed(evt);
  const a = await call('POST', '/api/webhooks/labelgrid', new Uint8Array(raw), headers);
  assert.equal(a.status, 200); assert.equal(a.json.duplicate, false); assert.equal(a.json.release, id);
  assert.equal(store.getRelease(id).status, 'live');
  const b = await call('POST', '/api/webhooks/labelgrid', new Uint8Array(raw), headers);
  assert.equal(b.json.duplicate, true);
});

test('webhook: firma incorrecta → 401 y no cambia nada', async (t) => {
  const { call } = await boot(t);
  const { raw } = signed({ event: 'x', timestamp: Date.now(), data: {} });
  const r = await call('POST', '/api/webhooks/labelgrid', new Uint8Array(raw), { 'x-webhook-signature': 'deadbeef' });
  assert.equal(r.status, 401);
});

test('webhook: si el cuerpo cambia un solo byte, la firma deja de valer', () => {
  const { raw, headers } = signed({ event: 'a', timestamp: Date.now(), data: { release_id: 1 } });
  assert.throws(() => verifyLabelGridWebhook(Buffer.concat([raw, Buffer.from(' ')]), headers, MOCK_WEBHOOK_SECRET), /inválida/);
});

test('webhook: se rechaza un evento viejo (>5 min) aunque la firma sea correcta (anti-replay)', () => {
  const { raw, headers } = signed({ event: 'a', timestamp: Math.floor((Date.now() - 6 * 60_000) / 1000), data: {} });
  assert.throws(() => verifyLabelGridWebhook(raw, headers, MOCK_WEBHOOK_SECRET), /ventana/);
  const ok = signed({ event: 'a', timestamp: Math.floor((Date.now() - 60_000) / 1000), data: { release_id: 1 } });
  assert.equal(verifyLabelGridWebhook(ok.raw, ok.headers, MOCK_WEBHOOK_SECRET).event, 'a');
});

test('webhook: sin secreto configurado se rechaza (fail closed)', () => {
  const { raw, headers } = signed({ event: 'a', timestamp: Date.now(), data: {} });
  assert.throws(() => verifyLabelGridWebhook(raw, headers, ''), /secreto/);
});
