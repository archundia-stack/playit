// Proveedor simulado: permite probar toda la interfaz sin credenciales ni red.
// El estado de entrega avanza con el tiempo (processing -> delivered -> live) de forma determinista.
import crypto from 'node:crypto';
import { verifyLabelGridWebhook } from './labelgrid.js';

const OUTLETS = [
  ['spotify', 'Spotify'], ['apple-music', 'Apple Music'], ['amazon-music', 'Amazon Music'],
  ['youtube-music', 'YouTube Music'], ['tidal', 'TIDAL'], ['deezer', 'Deezer'],
  ['tiktok', 'TikTok / Resso'], ['instagram-facebook', 'Instagram / Facebook'], ['pandora', 'Pandora'],
].map(([key, name], i) => ({ id: i + 1, key, name, type: 'store' }));

const GENRES = ['Pop', 'Latin Pop', 'Regional Mexicano', 'Reggaeton', 'Hip-Hop/Rap', 'Rock', 'Alternative', 'Electronic', 'Dance', 'R&B/Soul', 'Cumbia', 'Singer/Songwriter']
  .map((name, i) => ({ id: i + 1, name, category: null }));

export const MOCK_WEBHOOK_SECRET = 'mock-secret';

export class MockProvider {
  name = 'mock';

  constructor({ timing = { processingMs: 4000, deliveredMs: 9000 }, now = () => Date.now() } = {}) {
    this.timing = timing; this.now = now;
  }

  async getAccount() { return { name: 'Cuenta demo (mock)', email: 'demo@example.com' }; }

  async getCatalog() {
    return { labels: [{ id: 1, name: 'Mi Sello Records' }, { id: 2, name: 'Mi Sello Latin' }], genres: GENRES, outlets: OUTLETS };
  }

  async syncRelease(release) {
    const prev = release.provider ?? {};
    const providerReleaseId = prev.releaseId ?? String(100000 + Math.floor(Math.random() * 900000));
    const trackIds = { ...(prev.trackIds ?? {}) };
    for (const t of release.tracks) trackIds[t.id] ??= String(500000 + Math.floor(Math.random() * 400000));
    for (const k of Object.keys(trackIds)) if (!release.tracks.some((t) => t.id === k)) delete trackIds[k];
    return { providerReleaseId, trackIds };
  }

  async uploadAssets(release, files) {
    files.cover();
    for (const t of release.tracks) { const f = files.audio(t); if (f) t.audio.uploadedKey = `${f.size}:${f.filename}`; }
    return { ok: true };
  }

  async validate(release) {
    const errors = [];
    if (!release.cover?.filename) errors.push({ code: 'ARTWORK_MISSING', field: 'cover', message: 'La portada es obligatoria.' });
    release.tracks.forEach((t, i) => { if (!t.audio?.uploadedKey) errors.push({ code: 'AUDIO_MISSING', field: `tracks[${i}].audio`, message: `Falta audio en la pista ${i + 1}.` }); });
    const warnings = release.explicit === 'off' && /\b(fuck|mierda|puta)\b/i.test(release.title) ? [{ code: 'EXPLICIT_HINT', field: 'explicit', message: 'El título parece contener lenguaje explícito.' }] : [];
    return { ok: errors.length === 0, errors, warnings };
  }

  async distribute(release) {
    release.provider.submittedAt = this.now();
    return { status: 'submitted', message: 'Release enviado a entrega (simulado).' };
  }

  async getDeliveryStatus(release) {
    const p = release.provider ?? {};
    if (p.takedownAt) return { state: 'takedown', rawState: 'takedown', currentlyLive: false, everSubmitted: true, everDelivered: true, outlets: release.outlets.map((o) => ({ outlet: o, state: 'takedown' })) };
    if (!p.submittedAt) return { state: 'not_submitted', rawState: '', currentlyLive: false, everSubmitted: false, everDelivered: false, outlets: [] };
    const age = this.now() - p.submittedAt;
    const outlets = release.outlets.map((o, i) => {
      // Cada tienda avanza con un pequeño desfase
      const a = age - i * 400;
      const state = a < this.timing.processingMs ? 'processing' : a < this.timing.deliveredMs ? 'delivered' : 'live';
      return { outlet: o, state, rawState: state, updatedAt: new Date(p.submittedAt + Math.max(a, 0)).toISOString() };
    });
    const live = outlets.every((o) => o.state === 'live');
    const state = live ? 'live' : outlets.every((o) => o.state !== 'processing') ? 'delivered' : 'processing';
    return { state, rawState: state, currentlyLive: live, everSubmitted: true, everDelivered: state !== 'processing', outlets };
  }

  async takedown(release) { release.provider.takedownAt = this.now(); return { message: 'Baja solicitada (simulada).' }; }

  // Regalías sintéticas y deterministas, solo para pistas "en vivo".
  #rows(release, { from, to } = {}) {
    const rows = [];
    const months = lastMonths(6, this.now());
    for (const t of release.tracks) {
      for (const o of release.outlets) {
        for (const period of months) {
          if ((from && period < from.slice(0, 7)) || (to && period > to.slice(0, 7))) continue;
          const h = crypto.createHash('sha1').update(`${t.id}${o}${period}`).digest().readUInt16BE(0) / 65535;
          rows.push({ isrc: t.isrc || null, dsp: OUTLETS.find((x) => x.key === o)?.name ?? o, reportType: 'streaming', providerReleaseId: release.provider?.releaseId, territory: 'MX', period, currency: 'USD', grossUsd: Math.round(h * 4000) / 100, adjustment: false, trackTitle: t.title });
        }
      }
    }
    return rows;
  }

  async listStatements({ releases = [], from, to } = {}) {
    const byPeriod = {};
    for (const r of releases.filter((x) => x.provider?.submittedAt)) {
      for (const row of this.#rows(r, { from, to })) byPeriod[row.period] = (byPeriod[row.period] ?? 0) + row.grossUsd;
    }
    return Object.entries(byPeriod).sort().reverse().map(([period, gross]) => ({
      id: `MOCK-${period}`, period, scope: 'account', releaseId: null, currency: 'USD', grossUsd: round(gross),
      amount: round(gross * 0.85), providerFee: round(gross * 0.15), taxAmount: 0, totalDueUsd: round(gross * 0.85), status: 'paid', datePaid: `${period}-28`,
    }));
  }

  async getBreakdown({ releases = [], groupBy = 'dsp', from, to } = {}) {
    const rows = releases.filter((x) => x.provider?.submittedAt).flatMap((r) => this.#rows(r, { from, to }));
    return { rows, totalGrossUsd: round(rows.reduce((s, r) => s + r.grossUsd, 0)), groupBy };
  }

  verifyWebhook(rawBody, headers, now) { return verifyLabelGridWebhook(rawBody, headers, MOCK_WEBHOOK_SECRET, now); }
}

const round = (n) => Math.round(n * 100) / 100;
function lastMonths(n, nowMs) {
  const d = new Date(nowMs); const out = [];
  for (let i = n; i >= 1; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.toISOString().slice(0, 7)); }
  return out;
}
