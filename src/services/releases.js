import fs from 'node:fs';
import path from 'node:path';
import { HttpError, safeFilename, streamToFile } from '../http-utils.js';
import { validateRelease } from '../domain/validate.js';
import { LabelGridError } from '../providers/labelgrid.js';

const EDITABLE = new Set(['draft', 'error', 'attention']);
const clean = (s) => (typeof s === 'string' ? s.trim() : s);

export class ReleaseService {
  constructor({ store, provider, config }) { this.store = store; this.provider = provider; this.config = config; }

  list() { return this.store.listReleases().map(summary); }

  get(id) {
    const r = this.store.getRelease(id);
    if (!r) throw new HttpError(404, 'Lanzamiento no encontrado');
    return r;
  }

  create(input) {
    const now = new Date().toISOString();
    const release = this.#normalize({
      id: this.store.newId('rel_'), status: 'draft', createdAt: now, history: [], provider: null, delivery: null, cover: null,
    }, input);
    this.#log(release, 'creado', true);
    return this.store.putRelease(release);
  }

  update(id, input) {
    const cur = this.get(id);
    if (!EDITABLE.has(cur.status)) throw new HttpError(409, 'El lanzamiento ya fue enviado: los datos y el audio quedan bloqueados. Solicita una baja o crea una nueva versión.');
    return this.store.putRelease(this.#normalize(cur, input));
  }

  remove(id) {
    const cur = this.get(id);
    if (!['draft', 'error'].includes(cur.status)) throw new HttpError(409, 'Solo se pueden borrar borradores. Solicita una baja para lanzamientos enviados.');
    fs.rmSync(path.join(this.config.uploadDir, id), { recursive: true, force: true });
    this.store.deleteRelease(id);
  }

  precheck(id) { return validateRelease(this.get(id)); }

  // --- archivos ---

  async saveCover(id, filename, req) {
    const r = this.get(id);
    this.#assertEditable(r);
    if (!/\.(jpe?g|png)$/i.test(filename)) throw new HttpError(415, 'La portada debe ser JPG o PNG.');
    const name = safeFilename(filename);
    const dest = path.join(this.config.uploadDir, id, `cover-${name}`);
    const size = await streamToFile(req, dest, 30 * 1024 * 1024);
    r.cover = { filename: name, path: dest, size };
    return this.store.putRelease(r);
  }

  async saveAudio(id, trackId, filename, req) {
    const r = this.get(id);
    this.#assertEditable(r);
    const t = r.tracks.find((x) => x.id === trackId);
    if (!t) throw new HttpError(404, 'Pista no encontrada');
    if (!/\.(wav|flac|mp3)$/i.test(filename)) throw new HttpError(415, 'Formatos aceptados: WAV, FLAC (recomendados) o MP3.');
    const name = safeFilename(filename);
    const dest = path.join(this.config.uploadDir, id, `${trackId}-${name}`);
    const size = await streamToFile(req, dest, this.config.maxUploadBytes);
    t.audio = { filename: name, path: dest, size, uploadedKey: null };
    return this.store.putRelease(r);
  }

  // --- flujo de entrega ---

  async submit(id) {
    const r = this.get(id);
    this.#assertEditable(r);
    const pre = validateRelease(r);
    if (!pre.ok) throw new HttpError(422, 'El lanzamiento tiene errores por corregir.', { details: pre });

    const prevStatus = r.status;
    try {
      this.#log(r, 'sincronizando metadatos', true);
      const sync = await this.provider.syncRelease(r);
      r.provider = { ...(r.provider ?? {}), releaseId: sync.providerReleaseId, trackIds: sync.trackIds };
      this.store.putRelease(r);

      this.#log(r, 'subiendo portada y audio', true);
      await this.provider.uploadAssets(r, { cover: () => r.cover, audio: (t) => t.audio });
      this.store.putRelease(r);

      this.#log(r, 'validando con el proveedor', true);
      const v = await this.provider.validate(r);
      r.providerValidation = v;
      if (!v.ok) {
        r.status = 'error';
        this.#log(r, 'validación del proveedor', false, `${v.errors.length} error(es)`);
        this.store.putRelease(r);
        throw new HttpError(422, 'El proveedor reportó errores de validación.', { details: { ok: false, errors: v.errors, warnings: v.warnings } });
      }

      this.#log(r, 'enviando a distribución', true);
      const d = await this.provider.distribute(r);
      r.status = 'processing';
      r.delivery = { state: 'processing', outlets: [], checkedAt: null };
      r.lastError = null;
      this.#log(r, 'distribuido', true, d.message ?? d.status);
      return this.store.putRelease(r);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      r.status = prevStatus === 'draft' ? 'draft' : 'error';
      r.lastError = friendly(e);
      this.#log(r, 'fallo en envío', false, r.lastError);
      this.store.putRelease(r);
      throw new HttpError(e instanceof LabelGridError && e.status === 429 ? 429 : 502, r.lastError, { code: e.code ?? 'provider_error' });
    }
  }

  async refreshStatus(id) {
    const r = this.get(id);
    if (!r.provider?.releaseId || ['draft'].includes(r.status)) return r;
    const s = await this.provider.getDeliveryStatus(r);
    return this.#applyDelivery(r, s);
  }

  async refreshAll() {
    for (const r of this.store.listReleases()) {
      if (['processing', 'delivered', 'attention'].includes(r.status)) {
        try { await this.refreshStatus(r.id); } catch { /* se reintenta en el siguiente ciclo */ }
      }
    }
  }

  // Lo usa el webhook: no confía en la forma del payload, vuelve a consultar el estado.
  async refreshByProviderId(providerReleaseId) {
    const r = this.store.findReleaseByProviderId(providerReleaseId);
    if (!r) return null;
    return this.refreshStatus(r.id);
  }

  async takedown(id, opts = {}) {
    const r = this.get(id);
    if (!r.provider?.releaseId || !['processing', 'delivered', 'live', 'attention'].includes(r.status)) throw new HttpError(409, 'Solo se puede dar de baja un lanzamiento ya enviado.');
    try {
      const res = await this.provider.takedown(r, opts);
      r.status = 'takedown';
      r.delivery = { ...(r.delivery ?? {}), state: 'takedown' };
      this.#log(r, 'baja solicitada', true, res.message);
      return this.store.putRelease(r);
    } catch (e) {
      throw new HttpError(502, friendly(e), { code: e.code ?? 'provider_error' });
    }
  }

  // --- internos ---

  #applyDelivery(r, s) {
    const changed = r.delivery?.state !== s.state;
    r.delivery = { state: s.state, outlets: s.outlets, currentlyLive: s.currentlyLive, checkedAt: new Date().toISOString() };
    if (r.status !== 'takedown') r.status = s.state === 'not_submitted' ? r.status : s.state;
    if (changed) this.#log(r, `estado de entrega: ${s.state}`, s.state !== 'error');
    return this.store.putRelease(r);
  }

  #assertEditable(r) {
    if (!EDITABLE.has(r.status)) throw new HttpError(409, 'El lanzamiento ya fue enviado y no admite cambios.');
  }

  #log(r, step, ok, detail) {
    r.history = [...(r.history ?? []), { at: new Date().toISOString(), step, ok, ...(detail ? { detail } : {}) }].slice(-60);
  }

  #normalize(base, i) {
    const prevTracks = new Map((base.tracks ?? []).map((t) => [t.id, t]));
    const tracks = (i.tracks ?? []).map((t, idx) => {
      const prev = prevTracks.get(t.id);
      return {
        id: prev?.id ?? t.id ?? this.store.newId('trk_'),
        num: Number(t.num ?? idx + 1), disc: Number(t.disc ?? 1),
        title: clean(t.title) ?? '', titleLang: clean(t.titleLang) || i.titleLang || 'es',
        artists: (t.artists?.length ? t.artists : i.artists ?? []).map(artist),
        compositionType: t.compositionType ?? 'original_composition',
        audioLanguage: clean(t.audioLanguage) ?? '', explicit: t.explicit ?? 'off',
        isrc: clean(t.isrc) || '', recordingCountry: clean(t.recordingCountry) || 'MX',
        commercialSamples: t.commercialSamples ?? 'no',
        aiUsage: { audio: t.aiUsage?.audio ?? 'none', composition: t.aiUsage?.composition ?? 'none' },
        writers: (t.writers ?? []).map((w) => ({ firstName: clean(w.firstName) ?? '', lastName: clean(w.lastName) ?? '', roles: w.roles?.length ? w.roles : ['composer'], share: Number(w.share ?? 0) })),
        audio: prev?.audio ?? null,
      };
    });
    return {
      ...base,
      title: clean(i.title) ?? '', titleLang: clean(i.titleLang) || 'es',
      contentType: i.contentType ?? 'Single', labelId: i.labelId ? Number(i.labelId) : null,
      artists: (i.artists ?? []).map(artist), cat: clean(i.cat) ?? '', upc: clean(i.upc) || '',
      genreId: i.genreId ? Number(i.genreId) : null, explicit: i.explicit ?? 'off',
      releaseDate: clean(i.releaseDate) ?? '', outlets: [...new Set(i.outlets ?? [])],
      aiUsage: { artwork: i.aiUsage?.artwork ?? 'none' },
      tracks,
    };
  }
}

const artist = (a) => ({ name: clean(a.name) ?? '', role: a.role ?? 'primary' });

export function summary(r) {
  return {
    id: r.id, title: r.title, contentType: r.contentType, artists: r.artists, releaseDate: r.releaseDate, status: r.status,
    trackCount: r.tracks.length, cat: r.cat, outlets: r.outlets, delivery: r.delivery, updatedAt: r.updatedAt, hasCover: !!r.cover,
  };
}

export function friendly(e) {
  if (e instanceof LabelGridError) {
    if (e.status === 429 && e.code === 'release_submission_limit_exceeded') return `Alcanzaste el límite semanal de envíos de tu plan en LabelGrid${e.retryAfter ? ` (reintenta en ${e.retryAfter}s)` : ''}.`;
    if (e.status === 403 && /LOCKED/i.test(e.code ?? '')) return 'Campos bloqueados tras la distribución; crea una nueva versión del lanzamiento.';
    if (e.status === 401 || e.code === 'no_token') return 'LabelGrid rechazó el token o falta configurarlo (LABELGRID_TOKEN).';
    if (e.status === 403) return `LabelGrid denegó la operación (¿IP no permitida o plan sin API?): ${e.message}`;
    return `LabelGrid: ${e.message}`;
  }
  return e.message ?? String(e);
}
