// Persistencia mínima en un archivo JSON (escritura atómica). Suficiente para un prototipo;
// en producción se sustituye por PostgreSQL manteniendo la misma interfaz.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ releases: [], webhookEvents: {}, settings: {} });

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      try { this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
      catch (e) { throw new Error(`No pude leer ${file}: ${e.message}`); }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  newId(prefix = '') { return prefix + crypto.randomBytes(6).toString('hex'); }

  listReleases() { return this.data.releases; }
  getRelease(id) { return this.data.releases.find((r) => r.id === id) ?? null; }
  findReleaseByProviderId(pid) {
    return this.data.releases.find((r) => String(r.provider?.releaseId) === String(pid)) ?? null;
  }
  putRelease(release) {
    const i = this.data.releases.findIndex((r) => r.id === release.id);
    release.updatedAt = new Date().toISOString();
    if (i === -1) this.data.releases.unshift(release); else this.data.releases[i] = release;
    this.save();
    return release;
  }
  deleteRelease(id) {
    this.data.releases = this.data.releases.filter((r) => r.id !== id);
    this.save();
  }

  // Idempotencia de webhooks (entrega "at-least-once")
  hasEvent(key) { return key in this.data.webhookEvents; }
  markEvent(key) {
    this.data.webhookEvents[key] = new Date().toISOString();
    const keys = Object.keys(this.data.webhookEvents);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete this.data.webhookEvents[k];
    this.save();
  }

  getSetting(k, d = null) { return this.data.settings[k] ?? d; }
  setSetting(k, v) { this.data.settings[k] = v; this.save(); }
}
