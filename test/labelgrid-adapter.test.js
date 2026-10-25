import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLabelGrid } from './fake-labelgrid.js';
import { sampleRelease } from './fixtures.js';
import { LabelGridProvider, LabelGridError } from '../src/providers/labelgrid.js';
import { friendly } from '../src/services/releases.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
const wav = path.join(tmp, 'pista.wav'); fs.writeFileSync(wav, Buffer.alloc(2048));
const png = path.join(tmp, 'portada.png'); fs.writeFileSync(png, Buffer.alloc(512));
const withFiles = (r) => { r.cover.path = png; r.tracks[0].audio.path = wav; return r; };

async function setup(t) {
  const fake = await startFakeLabelGrid();
  t.after(() => fake.close());
  const provider = new LabelGridProvider({ apiUrl: fake.url, token: fake.token, webhookSecret: 's3cret' }, { uploadPollMs: 1 });
  return { fake, provider };
}

test('catálogo: etiquetas, géneros y tiendas (sin UGC)', async (t) => {
  const { provider } = await setup(t);
  const c = await provider.getCatalog();
  assert.deepEqual(c.labels, [{ id: 7, name: 'Mi Sello' }]);
  assert.equal(c.genres[0].name, 'Pop');
  assert.deepEqual(c.outlets.map((o) => o.key), ['spotify']);
  assert.equal((await provider.getAccount()).email, 'demo@labelgrid.test');
});

test('flujo completo: crea artistas/autores, release, pistas, sube audio y portada, valida y distribuye', async (t) => {
  const { fake, provider } = await setup(t);
  const r = withFiles(sampleRelease());
  const sync = await provider.syncRelease(r);
  r.provider = { releaseId: sync.providerReleaseId, trackIds: sync.trackIds };

  const rel = Object.values(fake.state.releases)[0];
  assert.equal(rel.content_type, 'Single');
  assert.equal(rel.label_id, 7);
  assert.equal(rel.primary_genre_id, 3);
  assert.deepEqual(rel.titles, [{ iso_code: 'es', text: 'Noches de Tequila' }]);
  assert.match(rel.release_date, /T00:00:00Z$/);
  assert.deepEqual(rel.dsp_configs, [{ distro_outlet_id: 'spotify', enabled: true }, { distro_outlet_id: 'apple-music', enabled: true }]);
  assert.equal(rel.artists.length, 2);
  assert.ok(!('audio_ai_usage' in rel) && !('composition_ai_usage' in rel), 'esos campos son por pista, no de release (OpenAPI)');
  assert.equal(fake.state.artists.length, 2);
  assert.equal(fake.state.writers.length, 2);

  const trk = Object.values(fake.state.tracks)[0];
  assert.equal(trk.release_id, rel.id);
  assert.equal(trk.writers.reduce((s, w) => s + w.percentage_share, 0), 100);
  assert.equal(trk.contributors.length, 2);
  assert.equal(trk.commercial_samples, 'no');

  await provider.uploadAssets(r, { cover: () => r.cover, audio: (tr) => tr.audio });
  assert.equal(fake.state.uploads.length, 1);
  assert.equal(fake.state.uploads[0].bytes, 2048);
  assert.ok(fake.state.attemptsPolled >= 2, 'espera a que termine el procesamiento del audio (202 + polling)');
  assert.ok(fake.state.calls.some((c) => c.path.endsWith('/photo')));

  const v = await provider.validate(r);
  assert.equal(v.ok, true);
  assert.equal(v.warnings[0].code, 'W1');
  assert.equal((await provider.distribute(r)).status, 'pending');
  assert.ok(fake.state.releases[sync.providerReleaseId].distributed);
});

test('re-sincronizar usa PATCH (sin content_type) y no duplica artistas ni pistas', async (t) => {
  const { fake, provider } = await setup(t);
  const r = withFiles(sampleRelease());
  const s1 = await provider.syncRelease(r);
  r.provider = { releaseId: s1.providerReleaseId, trackIds: s1.trackIds };
  r.title = 'Noches de Tequila (v2)';
  const s2 = await provider.syncRelease(r);
  assert.equal(s2.providerReleaseId, s1.providerReleaseId);
  assert.equal(Object.keys(fake.state.releases).length, 1);
  assert.equal(Object.keys(fake.state.tracks).length, 1);
  assert.equal(fake.state.artists.length, 2);
  assert.equal(Object.values(fake.state.releases)[0].titles[0].text, 'Noches de Tequila (v2)');
});

test('pistas quitadas en el portal se borran en el proveedor', async (t) => {
  const { fake, provider } = await setup(t);
  const r = withFiles(sampleRelease({ contentType: 'EP' }));
  r.tracks.push({ ...structuredClone(r.tracks[0]), id: 'trk_2', num: 2, title: 'Otra' });
  const s1 = await provider.syncRelease(r);
  r.provider = { releaseId: s1.providerReleaseId, trackIds: s1.trackIds };
  assert.equal(Object.keys(fake.state.tracks).length, 2);
  r.tracks.pop();
  await provider.syncRelease(r);
  assert.equal(Object.keys(fake.state.tracks).length, 1);
});

test('estado de entrega: normaliza y prioriza las tiendas que requieren acción', async (t) => {
  const { provider } = await setup(t);
  const s = await provider.getDeliveryStatus({ provider: { releaseId: '1001' } });
  assert.equal(s.state, 'attention');
  const ap = s.outlets.find((o) => o.outlet === 'apple-music');
  assert.equal(ap.state, 'attention');
  assert.equal(ap.actionUrl, 'https://app/fix');
  assert.equal(s.outlets.find((o) => o.outlet === 'spotify').state, 'delivered');
});

test('límite semanal (429) se traduce a un mensaje claro y no se reintenta', async (t) => {
  const { fake, provider } = await setup(t);
  fake.state.limit429 = true;
  await assert.rejects(() => provider.syncRelease(withFiles(sampleRelease())), (e) => {
    assert.ok(e instanceof LabelGridError); assert.equal(e.status, 429); assert.equal(e.retryAfter, 3600);
    assert.match(friendly(e), /límite semanal/); return true;
  });
  assert.equal(fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/releases').length, 1);
});

test('campos bloqueados (403) y token inválido tienen mensajes propios', async (t) => {
  const { fake } = await setup(t);
  assert.match(friendly(new LabelGridError(403, 'x', { code: 'RELEASE_LOCKED_FIELDS' })), /bloqueados/);
  const bad = new LabelGridProvider({ apiUrl: fake.url, token: 'otro' });
  await assert.rejects(() => bad.getAccount(), (e) => e.status === 401 && /token/i.test(friendly(e)));
  const none = new LabelGridProvider({ apiUrl: fake.url, token: '' });
  await assert.rejects(() => none.getAccount(), (e) => e.code === 'no_token');
});

test('las lecturas (GET) se reintentan ante 5xx', async (t) => {
  const { fake, provider } = await setup(t);
  fake.state.failNextGet = 2;
  assert.equal((await provider.getAccount()).name, 'Sello Demo');
});

test('regalías: estados de cuenta y desglose paginado por cursor', async (t) => {
  const { provider } = await setup(t);
  const st = await provider.listStatements();
  assert.equal(st[0].grossUsd, 120.5); assert.equal(st[0].providerFee, 20.5);
  const bd = await provider.getBreakdown({ groupBy: 'dsp' });
  assert.equal(bd.rows.length, 2); assert.equal(bd.totalGrossUsd, 5);
});

test('el token viaja solo en la cabecera Authorization', async (t) => {
  const { fake, provider } = await setup(t);
  await provider.getAccount();
  assert.ok(fake.state.calls.every((c) => c.auth === `Bearer ${fake.token}` || c.path.startsWith('/__s3')));
  assert.ok(!JSON.stringify(fake.state.calls.map((c) => c.body)).includes(fake.token));
});
