#!/usr/bin/env node
// Verifica que el adaptador siga alineado con el OpenAPI vigente de LabelGrid:
//   1) cada endpoint que usamos existe, 2) los cuerpos que generamos traen los campos requeridos,
//   3) no mandamos campos desconocidos y los enums tienen valores válidos.
// Uso: npm run check:spec -- ruta/a/api.json     (descárgalo de https://api.labelgrid.com/docs/api.json)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as M from '../src/providers/labelgrid-mappers.js';
import { sampleRelease } from '../test/fixtures.js';

const deref = (spec, s) => (s?.$ref ? deref(spec, s.$ref.split('/').slice(1).reduce((o, k) => o[k], spec)) : s);
function flat(spec, s) {
  s = deref(spec, s); if (!s) return s;
  const alts = s.allOf ?? [];
  if (alts.length) return alts.map((a) => flat(spec, a)).reduce((acc, x) => ({ ...acc, ...x, properties: { ...acc.properties, ...x.properties }, required: [...(acc.required ?? []), ...(x.required ?? [])] }), { ...s, allOf: undefined });
  return s;
}

function checkValue(spec, schema, value, where, out) {
  schema = flat(spec, schema); if (!schema || value == null) return;
  const opt = schema.anyOf ?? schema.oneOf;
  if (opt) { const nonNull = opt.map((o) => flat(spec, o)).filter((o) => o && o.type !== 'null'); if (nonNull.length === 1) return checkValue(spec, nonNull[0], value, where, out); return; }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${where}: "${value}" no está en el enum [${schema.enum.slice(0, 8).join(', ')}${schema.enum.length > 8 ? '…' : ''}]`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => checkValue(spec, schema.items, v, `${where}[${i}]`, out));
  else if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const r of schema.required ?? []) if (!(r in value)) out.push(`${where}: falta el campo requerido "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (!(k in schema.properties)) out.push(`${where}: campo desconocido "${k}"`);
      else checkValue(spec, schema.properties[k], v, `${where}.${k}`, out);
    }
  }
}

export function checkSpec(spec) {
  const problems = []; const notes = [];
  for (const ep of M.USED_ENDPOINTS) {
    const [method, p] = ep.split(' ');
    if (!spec.paths?.[p]?.[method.toLowerCase()]) problems.push(`Endpoint inexistente en el OpenAPI: ${ep}`);
  }
  const rel = sampleRelease();
  const artistIds = { 'luna arcos': 1, 'dj nopal': 2 }; const writerIds = { 'miguel|archundia': 10, '|rivas': 11 };
  const bodyOf = (method, p) => spec.paths?.[p]?.[method]?.requestBody?.content?.['application/json']?.schema;
  const samples = [
    ['post', '/releases', M.toReleaseCreate(rel, { artistIds })],
    ['post', '/tracks', M.toTrackCreate(rel.tracks[0], { providerReleaseId: 5, artistIds, writerIds })],
    ['post', '/artists', M.toArtistCreate('Luna Arcos')],
    ['post', '/writers', M.toWriterCreate(rel.tracks[0].writers[0])],
    ['patch', '/releases/{release}', M.toReleasePatch(rel, { artistIds })],
  ];
  for (const [method, p, body] of samples) {
    const schema = bodyOf(method, p);
    if (!schema) { problems.push(`Sin esquema de petición para ${method.toUpperCase()} ${p}`); continue; }
    checkValue(spec, schema, body, `${method.toUpperCase()} ${p}`, problems);
  }
  notes.push('Pendiente de verificar a mano en sandbox: forma del objeto `roles` (writers/contributors), valores de `artistic_role`, valores de `state` en delivery-status y `status` en upload attempts, y valores de `group_by` en /royalties/breakdown.');
  return { problems, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('Uso: npm run check:spec -- ruta/a/api.json'); process.exit(2); }
  const { problems, notes } = checkSpec(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (problems.length) { console.error(`✗ ${problems.length} problema(s):\n` + problems.map((p) => ' - ' + p).join('\n')); }
  else console.log('✓ El adaptador coincide con el OpenAPI en endpoints, campos requeridos, campos conocidos y enums.');
  for (const n of notes) console.log('ℹ ' + n);
  process.exit(problems.length ? 1 : 0);
}
