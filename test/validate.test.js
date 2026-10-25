import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../src/domain/validate.js';
import { sampleRelease } from './fixtures.js';

test('un lanzamiento completo es válido', () => assert.equal(validateRelease(sampleRelease()).ok, true));

test('detecta autoría que no suma 100%', () => {
  const r = sampleRelease(); r.tracks[0].writers[0].share = 50;
  const v = validateRelease(r);
  assert.equal(v.ok, false); assert.match(v.errors.map((e) => e.message).join(' '), /suman 90%/);
});

test('exige portada, audio, artista principal y plataformas', () => {
  const r = sampleRelease({ cover: null, outlets: [], artists: [{ name: 'X Y', role: 'featuring' }] }); r.tracks[0].audio = null;
  const f = validateRelease(r).errors.map((e) => e.field);
  for (const k of ['cover', 'outlets', 'artists', 'tracks[0].audio']) assert.ok(f.includes(k), k);
});

test('catálogo > 20 caracteres, UPC y ISRC con formato inválido', () => {
  const r = sampleRelease({ cat: 'x'.repeat(21), upc: '123' }); r.tracks[0].isrc = 'ABC';
  const f = validateRelease(r).errors.map((e) => e.field);
  assert.ok(f.includes('cat') && f.includes('upc') && f.includes('tracks[0].isrc'));
});

test('avisa (sin bloquear) de fechas con poco margen y audio con pérdida', () => {
  const r = sampleRelease({ releaseDate: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) }); r.tracks[0].audio.filename = 'a.mp3';
  const v = validateRelease(r); assert.equal(v.ok, true); assert.equal(v.warnings.length, 2);
});
