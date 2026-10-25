// Validación local previa al envío: atrapa lo evidente antes de gastar una entrega
// (LabelGrid limita envíos semanales). La validación final la hace el proveedor.
export const CONTENT_TYPES = ['Single', 'EP', 'Album', 'Compilation', 'Mix', 'Podcast'];
export const AI_LEVELS = ['none', 'some', 'material', 'all'];
export const COMPOSITION_TYPES = ['original_composition', 'cover_song', 'public_domain'];
export const ARTIST_ROLES = ['primary', 'featuring', 'remixer'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

export function validateRelease(r) {
  const errors = []; const warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });

  if (!r.title?.trim()) err('title', 'Falta el título del lanzamiento.');
  if (!CONTENT_TYPES.includes(r.contentType)) err('contentType', 'Tipo de lanzamiento no válido.');
  if (!r.labelId) err('labelId', 'Selecciona un sello.');
  if (!r.cat?.trim()) err('cat', 'Falta el número de catálogo.');
  else if (r.cat.length > 20) err('cat', 'El catálogo admite máximo 20 caracteres.');
  if (!r.genreId) err('genreId', 'Selecciona el género principal.');
  if (!r.releaseDate || !ISO_DATE.test(r.releaseDate)) err('releaseDate', 'Fecha de lanzamiento inválida.');
  else if (new Date(r.releaseDate) < new Date(Date.now() - 86400000)) warn('releaseDate', 'La fecha ya pasó: las tiendas podrían rechazar el pre-order.');
  else if (new Date(r.releaseDate) < new Date(Date.now() + 7 * 86400000)) warn('releaseDate', 'Menos de 7 días de margen: recomendable ≥ 7 para pitching y revisión de tiendas.');

  if (!AI_LEVELS.includes(r.aiUsage?.artwork)) err('aiUsage.artwork', 'Declara el uso de IA en la portada.');

  const primaries = (r.artists ?? []).filter((a) => a.role === 'primary' && a.name?.trim());
  if (!primaries.length) err('artists', 'Agrega al menos un artista principal.');
  for (const a of r.artists ?? []) {
    if (a.name && a.name.trim().length < 2) err('artists', `Nombre de artista demasiado corto: "${a.name}".`);
    if (a.name && a.name.length > 64) err('artists', `Nombre de artista > 64 caracteres: "${a.name.slice(0, 20)}…".`);
  }

  if (!r.outlets?.length) err('outlets', 'Selecciona al menos una tienda/plataforma de destino.');
  if (!r.cover?.filename) err('cover', 'Falta la portada (3000×3000 px recomendado, JPG/PNG).');

  const tracks = r.tracks ?? [];
  if (!tracks.length) err('tracks', 'Agrega al menos una pista.');
  if (r.contentType === 'Single' && tracks.length > 1) warn('tracks', 'Un Single suele tener 1–3 pistas; considera EP.');
  if (r.contentType === 'EP' && tracks.length > 6) warn('tracks', 'Un EP suele tener hasta 6 pistas.');

  const seen = new Set();
  tracks.forEach((t, i) => {
    const p = `tracks[${i}]`;
    if (!t.title?.trim()) err(`${p}.title`, `Pista ${i + 1}: falta el título.`);
    const key = `${t.disc ?? 1}-${t.num ?? i + 1}`;
    if (seen.has(key)) err(`${p}.num`, `Pista ${i + 1}: disco/posición repetidos.`); seen.add(key);
    if (!COMPOSITION_TYPES.includes(t.compositionType)) err(`${p}.compositionType`, `Pista ${i + 1}: tipo de composición no válido.`);
    if (!t.audioLanguage?.trim()) err(`${p}.audioLanguage`, `Pista ${i + 1}: indica el idioma del audio ("zxx" si es instrumental).`);
    if (!t.audio?.filename) err(`${p}.audio`, `Pista ${i + 1}: falta el archivo de audio (WAV 16/24-bit recomendado).`);
    else if (!/\.(wav|flac)$/i.test(t.audio.filename)) warn(`${p}.audio`, `Pista ${i + 1}: se recomienda WAV o FLAC sin pérdida.`);
    for (const k of ['audio', 'composition']) {
      if (!AI_LEVELS.includes(t.aiUsage?.[k])) err(`${p}.aiUsage.${k}`, `Pista ${i + 1}: declara el uso de IA (${k}).`);
    }
    const writers = t.writers ?? [];
    if (!writers.length) warn(`${p}.writers`, `Pista ${i + 1}: sin autores/compositores; las tiendas lo piden para crédito y regalías.`);
    else {
      const sum = writers.reduce((s, w) => s + Number(w.share || 0), 0);
      if (Math.abs(sum - 100) > 0.001) err(`${p}.writers`, `Pista ${i + 1}: los porcentajes de autoría suman ${sum}%, deben sumar 100%.`);
      for (const w of writers) if (!w.lastName?.trim()) err(`${p}.writers`, `Pista ${i + 1}: autor sin apellido.`);
    }
    if (t.isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc.replace(/-/g, ''))) err(`${p}.isrc`, `Pista ${i + 1}: ISRC con formato inválido.`);
  });

  if (r.upc && !/^\d{12,13}$/.test(r.upc)) err('upc', 'UPC/EAN debe tener 12 o 13 dígitos (o déjalo vacío para asignación automática).');
  return { ok: errors.length === 0, errors, warnings };
}
