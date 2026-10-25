// Traducción pura (sin red) entre el modelo del portal y la API pública de LabelGrid.
// Fuente: OpenAPI 3.1 en https://api.labelgrid.com/docs/api.json (leída al construir el prototipo).
// Todo lo marcado "SUPUESTO" no está definido con precisión en el OpenAPI y debe confirmarse
// en el sandbox antes de producción (ver README, sección "Pendiente de verificar").

// SUPUESTO: valores aceptados por artistic_role (el esquema solo dice "string").
export const ARTIST_ROLE_MAP = { primary: 'Primary', featuring: 'Featuring', remixer: 'Remixer' };

// SUPUESTO: forma del objeto `roles` de writers/contributors (el esquema solo dice "object").
// Se envía como { "<Rol>": true }. Si el sandbox exige ids, cambiar SOLO esta función.
export function rolesObject(roles) {
  return Object.fromEntries(roles.map((r) => [r, true]));
}

export const WRITER_ROLE_MAP = { composer: 'Composer', lyricist: 'Lyricist' };

export function toArtistCreate(name) {
  return { artist_name: name.trim() }; // requerido; 2–64 caracteres
}

export function toWriterCreate(w) {
  const body = { last_name: w.lastName.trim() }; // last_name requerido
  if (w.firstName?.trim()) body.first_name = w.firstName.trim();
  return body;
}

export function toDspConfigs(outlets) {
  // distro_outlet_id acepta slug (key) o id numérico.
  return outlets.map((o) => ({ distro_outlet_id: o, enabled: true }));
}

export function toReleaseCreate(release, { artistIds, labelId = release.labelId }) {
  const body = {
    content_type: release.contentType,
    label_id: Number(labelId),
    artists: release.artists.map((a, i) => ({
      artist_id: artistIds[a.name.trim().toLowerCase()],
      artistic_role: ARTIST_ROLE_MAP[a.role] ?? ARTIST_ROLE_MAP.primary,
      position: i + 1,
    })),
    titles: [{ iso_code: release.titleLang || 'es', text: release.title.trim() }],
    cat: release.cat.trim(),
    primary_genre_id: Number(release.genreId),
    artwork_ai_usage: release.aiUsage.artwork, // el uso de IA en audio/composición se declara por pista
    explicit: release.explicit ?? 'off',
    release_date: toUtcDateTime(release.releaseDate),
    preferred_localization: release.titleLang || 'es',
    dsp_configs: toDspConfigs(release.outlets),
  };
  if (release.upc) body.barcode_number = release.upc; // vacío = asignación automática
  return body;
}

// PATCH /releases/{id}: mismos campos, sin los inmutables tras crear.
export function toReleasePatch(release, ctx) {
  const { content_type, ...rest } = toReleaseCreate(release, ctx);
  return rest;
}

export function toTrackCreate(track, { providerReleaseId, artistIds, writerIds }) {
  const body = {
    release_id: Number(providerReleaseId),
    disc: track.disc ?? 1,
    track_num: track.num,
    titles: [{ iso_code: track.titleLang || 'es', text: track.title.trim() }],
    composition_type: track.compositionType,
    artists: track.artists.map((a, i) => ({
      artist_id: artistIds[a.name.trim().toLowerCase()],
      artistic_role: ARTIST_ROLE_MAP[a.role] ?? ARTIST_ROLE_MAP.primary,
      position: i + 1,
    })),
    audio_ai_usage: track.aiUsage.audio,
    composition_ai_usage: track.aiUsage.composition,
    commercial_samples: track.commercialSamples ?? 'no',
    audio_language: track.audioLanguage,
    explicit: track.explicit ?? 'off',
    // La guía del MCP de LabelGrid lo trata como requerido aunque el OpenAPI no lo marque.
    recording_country: track.recordingCountry || 'MX',
    // Los contributors son obligatorios en el esquema; se declaran los autores como Composer/Lyricist.
    contributors: track.writers.map((w) => ({
      writer_id: writerIds[writerKey(w)],
      roles: rolesObject(w.roles.map((r) => WRITER_ROLE_MAP[r] ?? 'Composer')),
      ai_contribution: 'none',
    })),
    writers: track.writers.map((w) => ({
      writer_id: writerIds[writerKey(w)],
      roles: rolesObject(w.roles.map((r) => WRITER_ROLE_MAP[r] ?? 'Composer')),
      percentage_share: Number(w.share),
    })),
  };
  if (track.isrc) body.isrc = track.isrc.replace(/-/g, '');
  return body;
}

export function writerKey(w) {
  return `${(w.firstName ?? '').trim()}|${w.lastName.trim()}`.toLowerCase();
}

export function toUtcDateTime(d) {
  // "2026-11-20" -> "2026-11-20T00:00:00Z"
  return /T/.test(d) ? new Date(d).toISOString() : `${d}T00:00:00Z`;
}

// --- Respuestas -> modelo del portal ---

export function fromValidate(resp) {
  const map = (x) => ({ code: x.code, field: x.field, entityType: x.entity_type, entityId: x.entity_id, message: x.message });
  const errors = (resp.errors_structured ?? resp.errors?.map((m) => ({ message: String(m) })) ?? []).map(map);
  const warnings = (resp.warnings_structured ?? resp.warnings?.map((m) => ({ message: String(m) })) ?? []).map(map);
  return { ok: resp.result === 'OK' && errors.length === 0, errors, warnings };
}

// Estados de entrega de LabelGrid -> estados normalizados del portal.
// SUPUESTO: valores exactos de `state` / `customer_state`; se mapea por palabras clave y se conserva el crudo.
export function normalizeState(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return 'not_submitted';
  if (/takedown|removed|taken_down/.test(s)) return 'takedown';
  if (/(^|[^a-z])(live|published)([^a-z]|$)/.test(s)) return 'live'; // ojo: "delivered" contiene "live"
  if (/^live/.test(s)) return 'live';
  if (/deliver|complete|distributed|success/.test(s)) return 'delivered';
  if (/error|fail|reject/.test(s)) return 'error';
  if (/attention|action|review|blocked/.test(s)) return 'attention';
  if (/pend|queue|process|submit|progress|sent/.test(s)) return 'processing';
  return 'processing';
}

export function fromDeliveryStatus(resp) {
  const outlets = (resp.outlets ?? []).map((o) => ({
    outlet: o.outlet,
    state: normalizeState(o.customer_state || o.state),
    rawState: o.state,
    operation: o.operation,
    error: o.error_code ?? null,
    actionUrl: o.action_url ?? null,
    actionCode: o.customer_action_code ?? null,
    updatedAt: o.updated_at ?? null,
  }));
  let state = normalizeState(resp.state);
  if (resp.currently_live) state = 'live';
  else if (outlets.some((o) => o.state === 'error')) state = 'error';
  else if (outlets.some((o) => o.state === 'attention')) state = 'attention';
  return {
    state,
    rawState: resp.state,
    currentlyLive: !!resp.currently_live,
    everSubmitted: !!resp.ever_submitted,
    everDelivered: !!resp.ever_delivered,
    outlets,
  };
}

export function fromStatement(s) {
  return {
    id: s.invoice_number ?? `${s.scope}:${s.period}:${s.release_id ?? 'all'}`,
    period: s.period,
    scope: s.scope,
    releaseId: s.release_id ?? null,
    currency: s.currency,
    grossUsd: s.gross_usd ?? 0,
    amount: s.amount ?? null,
    providerFee: s.labelgrid_fee ?? null,
    taxAmount: s.tax_amount ?? null,
    totalDueUsd: s.total_due_usd ?? null,
    status: s.status ?? null,
    datePaid: s.date_paid ?? null,
  };
}

export function fromBreakdownRow(r) {
  return {
    isrc: r.isrc, dsp: r.dsp_name ?? r.dsp, reportType: r.report_type, providerReleaseId: r.release_id,
    territory: r.territory, period: r.period, currency: r.currency, grossUsd: r.gross_usd, adjustment: !!r.adjustment,
  };
}

// Endpoints que usa el adaptador. `npm run check:spec -- api.json` verifica que existan en el OpenAPI vigente.
export const USED_ENDPOINTS = [
  'GET /me', 'GET /labels', 'GET /genres', 'GET /distro-outlets',
  'GET /artists', 'POST /artists', 'GET /writers', 'POST /writers',
  'POST /releases', 'PATCH /releases/{release}', 'POST /releases/{release}/photo',
  'POST /tracks', 'PATCH /tracks/{track}', 'DELETE /tracks/{track}',
  'POST /tracks/{track}/files/{fileType}/upload-url', 'PUT /tracks/{track}/files/{fileType}', 'GET /tracks/{track}/file-upload-attempts/{uploadAttempt}',
  'POST /releases/{release}/validate', 'POST /releases/{release}/distribute', 'POST /releases/{release}/takedown-all',
  'GET /releases/{releaseId}/delivery-status', 'GET /statements', 'GET /royalties/breakdown',
];
