export class RoyaltyService {
  constructor({ store, provider }) { this.store = store; this.provider = provider; }

  async statements({ from, to } = {}) {
    return this.provider.listStatements({ releases: this.store.listReleases(), from, to });
  }

  // Desglose enriquecido con los títulos locales y agregado por plataforma / periodo / pista.
  async breakdown({ groupBy = 'dsp', from, to, releaseId } = {}) {
    const local = releaseId ? this.store.getRelease(releaseId) : null;
    const res = await this.provider.getBreakdown({
      groupBy, from, to, releaseId: local?.provider?.releaseId,
      releases: local ? [local] : this.store.listReleases(),
    });
    const byDsp = {}; const byPeriod = {}; const byIsrc = {};
    for (const r of res.rows) {
      byDsp[r.dsp ?? '—'] = add(byDsp[r.dsp ?? '—'], r.grossUsd);
      byPeriod[r.period ?? '—'] = add(byPeriod[r.period ?? '—'], r.grossUsd);
      byIsrc[r.isrc ?? r.trackTitle ?? '—'] = add(byIsrc[r.isrc ?? r.trackTitle ?? '—'], r.grossUsd);
    }
    return { totalGrossUsd: res.totalGrossUsd, byDsp: sorted(byDsp), byPeriod: sorted(byPeriod, true), byTrack: sorted(byIsrc), rowCount: res.rows.length };
  }
}
const add = (a = 0, b = 0) => Math.round((a + b) * 100) / 100;
const sorted = (o, byKey = false) => Object.entries(o).map(([key, grossUsd]) => ({ key, grossUsd })).sort((a, b) => (byKey ? a.key.localeCompare(b.key) : b.grossUsd - a.grossUsd));
