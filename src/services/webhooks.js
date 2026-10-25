import { LabelGridError } from '../providers/labelgrid.js';
import { HttpError } from '../http-utils.js';

export class WebhookService {
  constructor({ store, provider, releases }) { this.store = store; this.provider = provider; this.releases = releases; }

  // rawBody debe ser el Buffer EXACTO recibido (la firma se calcula sobre bytes crudos).
  async handle(rawBody, headers) {
    let evt;
    try { evt = this.provider.verifyWebhook(rawBody, headers); }
    catch (e) {
      if (e instanceof LabelGridError) throw new HttpError(e.status === 500 ? 500 : e.status, e.message, { code: e.code });
      throw e;
    }
    if (this.store.hasEvent(evt.key)) return { duplicate: true, event: evt.event };

    const releaseId = evt.data.release_id ?? evt.data.releaseId;
    let updated = null;
    if (releaseId != null) updated = await this.releases.refreshByProviderId(releaseId);
    else await this.releases.refreshAll();
    this.store.markEvent(evt.key); // se marca al final: si falló la consulta, el reintento del proveedor reprocesa
    return { duplicate: false, event: evt.event, release: updated?.id ?? null };
  }
}
