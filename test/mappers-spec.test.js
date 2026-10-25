import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, fromDeliveryStatus } from '../src/providers/labelgrid-mappers.js';
import { checkSpec } from '../scripts/check-spec.js';

test('normalizeState: "delivered" NO es "live" (regresión) y reconoce los demás estados', () => {
  assert.equal(normalizeState('delivered'), 'delivered');
  assert.equal(normalizeState('live'), 'live');
  assert.equal(normalizeState('currently_live'), 'live');
  assert.equal(normalizeState('failed'), 'error');
  assert.equal(normalizeState('needs_attention'), 'attention');
  assert.equal(normalizeState('queued'), 'processing');
  assert.equal(normalizeState('taken_down'), 'takedown');
  assert.equal(normalizeState(''), 'not_submitted');
});

test('fromDeliveryStatus: currently_live manda sobre el estado crudo', () => {
  assert.equal(fromDeliveryStatus({ state: 'x', currently_live: true, outlets: [] }).state, 'live');
});

// OpenAPI mínimo con la misma forma que el real, para probar el verificador sin red.
const mini = (over = {}) => ({
  paths: {
    '/releases': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/R' } } } } } },
  },
  components: { schemas: { R: { type: 'object', required: ['content_type', 'label_id'], properties: { content_type: { enum: ['Single', 'EP'] }, label_id: { type: 'integer' }, cat: {}, ...over } } } },
});
test('check-spec: detecta endpoints ausentes, campos desconocidos y enums inválidos', () => {
  const { problems } = checkSpec(mini());
  assert.ok(problems.some((p) => /Endpoint inexistente.*GET \/me/.test(p)));
  assert.ok(problems.some((p) => /campo desconocido "titles"/.test(p)));
  const bad = checkSpec(mini({ content_type: { enum: ['Album'] } }));
  assert.ok(bad.problems.some((p) => /"Single" no está en el enum/.test(p)));
});
