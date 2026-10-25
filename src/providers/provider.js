// Contrato que debe cumplir cualquier proveedor de entrega (mayorista).
// El portal NUNCA habla con un mayorista directamente: solo con esta interfaz.
// Cambiar de LabelGrid a Revelator/FUGA = escribir otro adaptador que implemente esto.
//
//   name                                  string
//   getAccount()                          -> { name, email }
//   getCatalog()                          -> { labels:[{id,name}], genres:[{id,name,category}], outlets:[{id,key,name,type}] }
//   syncRelease(release)                  -> { providerReleaseId, trackIds: { [localTrackId]: id } }   (crea/actualiza borrador remoto)
//   uploadAssets(release, files)          -> { ok }   files = { readAudio(track), readCover() } streams locales
//   validate(release)                     -> { ok, errors:[{code,field,message}], warnings:[...] }
//   distribute(release)                   -> { status }
//   getDeliveryStatus(release)            -> { state, outlets:[{outlet,state,error,actionUrl,updatedAt}] }
//   takedown(release, opts)               -> { message }
//   listStatements({from,to})             -> [{ id, period, currency, grossUsd, amount, status, ... }]
//   getBreakdown({groupBy, from, to, releaseId}) -> { rows:[...], totalGrossUsd }
//   verifyWebhook(rawBody, headers)       -> { event, id, data, timestamp }  (lanza si es inválido)
//
// Estados normalizados de entrega: 'not_submitted' | 'processing' | 'delivered' | 'live' | 'attention' | 'error' | 'takedown'

import { MockProvider } from './mock.js';
import { LabelGridProvider } from './labelgrid.js';

export function createProvider(config, deps = {}) {
  switch (config.provider) {
    case 'mock': return new MockProvider(deps);
    case 'labelgrid': return new LabelGridProvider(config.labelgrid, deps);
    default: throw new Error(`PROVIDER desconocido: ${config.provider}`);
  }
}
