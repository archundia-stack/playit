// SPA sin dependencias. Todo el acceso a datos pasa por /api; el token del proveedor nunca llega aquí.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');

const STATUS = { draft: 'Borrador', processing: 'En proceso', delivered: 'Entregado', live: 'En vivo', attention: 'Requiere acción', error: 'Con error', takedown: 'Dado de baja', not_submitted: 'Sin enviar' };
const AI = [['none', 'Sin IA'], ['some', 'Algo de IA'], ['material', 'IA sustancial'], ['all', 'Todo con IA']];
const COMP = [['original_composition', 'Composición original'], ['cover_song', 'Cover de otra obra'], ['public_domain', 'Dominio público']];
const LANGS = [['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['zxx', 'Instrumental (sin letra)']];
const ROLES = [['primary', 'Principal'], ['featuring', 'Invitado (feat.)'], ['remixer', 'Remixer']];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

let catalog = null; let account = null; let timer = null;

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : raw });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, details: data.details });
  return data;
}
function toast(msg, bad = false) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
function confirmDialog(text, yes = 'Confirmar') {
  return new Promise((resolve) => {
    const d = $('#confirm'); $('#confirm-text').textContent = text; $('#confirm-yes').textContent = yes;
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }); d.showModal();
  });
}
const fmtDate = (d) => { if (!d) return '—'; const [y, m, day] = d.slice(0, 10).split('-'); return `${+day} ${MONTHS[+m - 1]} ${y}`; };
const fmtTime = (iso) => new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
const money = (n) => (n ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'USD' });
const artistsLine = (r) => (r.artists ?? []).map((a) => a.name).join(', ') || 'Sin artista';
const chip = (s) => `<span class="chip ${s}">${STATUS[s] ?? s}</span>`;
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');

// ---------- piezas de interfaz ----------
function lane(o) {
  const step = { processing: 1, delivered: 2, live: 3, error: 1, attention: 1, takedown: 3 }[o.state] ?? 0;
  const label = { processing: 'Procesando', delivered: 'Entregada', live: 'En vivo', error: 'Error de entrega', attention: 'Requiere tu acción', takedown: 'Dada de baja' }[o.state] ?? '';
  const extra = o.actionUrl ? ` · <a href="${esc(o.actionUrl)}" target="_blank" rel="noopener">resolver</a>` : o.error ? ` · ${esc(o.error)}` : '';
  return `<div class="lane" data-state="${o.state}"><span>${esc(outletName(o.outlet))}</span>
    <div class="track" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
    <span class="lane-state">${label}${extra}</span></div>`;
}
const outletName = (key) => catalog?.outlets.find((o) => o.key === key || String(o.id) === String(key))?.name ?? key;
function miniLane(r) {
  const outs = r.delivery?.outlets ?? [];
  if (!outs.length) return '';
  const rank = { processing: 1, delivered: 2, live: 3 }; const min = Math.min(...outs.map((o) => rank[o.state] ?? 1));
  return `<div class="lane lane-mini" style="display:block;border:0;padding:0" data-state="${r.status}"><div class="track">${[1, 2, 3].map((i) => `<i class="${i <= min ? 'on' : ''}"></i>`).join('')}</div></div>`;
}
function item(r, wide = false) {
  return `<div class="item${wide ? ' wide' : ''}">
    <img class="cover" src="/api/releases/${r.id}/cover" alt="" onerror="this.removeAttribute('src')">
    <div><a class="title" href="#/lanzamiento/${r.id}">${esc(r.title || 'Sin título')}</a>
      <div class="muted">${esc(artistsLine(r))} · ${esc(r.contentType)} · ${r.trackCount} ${r.trackCount === 1 ? 'pista' : 'pistas'} · ${fmtDate(r.releaseDate)}</div></div>
    ${wide ? `<div>${miniLane(r)}</div>` : ''}<div>${chip(r.status)}</div></div>`;
}
const list = (rows, wide, empty) => rows.length ? `<div class="list">${rows.map((r) => item(r, wide)).join('')}</div>` : `<div class="empty">${empty}</div>`;

function barChart(byPeriod) {
  if (!byPeriod.length) return '<div class="empty">Aún no hay regalías. Aparecerán cuando tus lanzamientos estén en vivo.</div>';
  const max = Math.max(...byPeriod.map((p) => p.grossUsd), 1);
  return `<div class="bars" role="img" aria-label="Regalías brutas por mes">${byPeriod.map((p) => `<div><span>${money(p.grossUsd)}</span><b style="height:${Math.max(2, (p.grossUsd / max) * 100)}px"></b><span>${MONTHS[+p.key.slice(5, 7) - 1] ?? ''} ${p.key.slice(2, 4)}</span></div>`).join('')}</div>`;
}

// ---------- vistas ----------
const views = {
  async panel() {
    const [rels, roy] = await Promise.all([api('/releases'), api('/royalties/breakdown').catch(() => null)]);
    const attention = rels.filter((r) => ['error', 'attention'].includes(r.status));
    const flight = rels.filter((r) => ['processing', 'delivered'].includes(r.status));
    const drafts = rels.filter((r) => r.status === 'draft');
    main.innerHTML = `<div class="head"><div><h1>Panel</h1><p>${rels.length} lanzamientos · ${rels.filter((r) => r.status === 'live').length} en vivo</p></div>
      <a class="btn primary" href="#/lanzamiento/nuevo">Nuevo lanzamiento</a></div>
      ${attention.length ? `<section class="section"><header><h2>Necesitan tu atención</h2></header>${list(attention, true)}</section>` : ''}
      <section class="section"><header><h2>En entrega</h2></header>${list(flight, true, 'Nada en camino ahora mismo. Envía un lanzamiento a distribución y lo verás avanzar aquí.')}</section>
      <section class="section"><header><h2>Borradores</h2></header>${list(drafts, false, 'No tienes borradores.')}</section>
      <section class="section"><header><h2>Regalías brutas por mes</h2><a href="#/regalias">Ver detalle</a></header>${roy ? barChart(roy.byPeriod) : '<div class="empty">Regalías no disponibles con esta conexión.</div>'}</section>`;
    if (flight.length) schedule(() => views.panel(), 6000);
  },

  async catalogo() {
    const rels = await api('/releases');
    main.innerHTML = `<div class="head"><div><h1>Catálogo</h1><p>${rels.length} lanzamientos</p></div><a class="btn primary" href="#/lanzamiento/nuevo">Nuevo lanzamiento</a></div>
      ${list(rels, true, 'Tu catálogo está vacío. Crea el primer lanzamiento.')}`;
  },

  async detalle(id) {
    let r = await api(`/releases/${id}`);
    if (['processing', 'delivered', 'attention'].includes(r.status)) r = await api(`/releases/${id}/refresh`, { method: 'POST' }).catch(() => r);
    const editable = ['draft', 'error', 'attention'].includes(r.status);
    const sent = r.provider?.releaseId && r.status !== 'draft';
    main.innerHTML = `<div class="head"><div class="row" style="gap:18px;align-items:flex-start"><img class="cover big" src="/api/releases/${r.id}/cover" alt="Portada de ${esc(r.title)}" onerror="this.removeAttribute('src')">
        <div><h1>${esc(r.title)}</h1><p>${esc(artistsLine(r))}</p><div style="margin-top:10px">${chip(r.status)}</div></div></div>
      <div class="row">${editable ? `<a class="btn" href="#/lanzamiento/${r.id}/editar">Editar</a>` : ''}
        ${sent ? '<button class="btn" id="refresh">Actualizar estado</button>' : ''}
        ${sent && r.status !== 'takedown' ? '<button class="btn danger" id="takedown">Dar de baja</button>' : ''}
        ${r.status === 'draft' || r.status === 'error' ? '<button class="btn danger" id="delete">Borrar borrador</button>' : ''}</div></div>
      ${r.lastError ? `<div class="callout bad">${esc(r.lastError)}</div>` : ''}
      ${r.providerValidation && !r.providerValidation.ok ? `<section class="section"><h2>Errores del proveedor</h2><ul class="issues" style="margin-top:10px">${r.providerValidation.errors.map((e) => `<li class="e">${esc(e.message)}</li>`).join('')}</ul></section>` : ''}
      <section class="section"><header><h2>Entrega por plataforma</h2></header>
        ${r.delivery?.outlets?.length ? `<div class="lanes">${r.delivery.outlets.map(lane).join('')}</div>`
          : `<div class="empty">${r.status === 'draft' ? 'Este lanzamiento aún no se ha enviado.' : 'Esperando el primer reporte de las plataformas.'}</div>`}</section>
      <section class="section"><header><h2>Datos</h2></header><dl class="meta">
        <div><dt>Tipo</dt><dd>${esc(r.contentType)}</dd></div><div><dt>Fecha de lanzamiento</dt><dd>${fmtDate(r.releaseDate)}</dd></div>
        <div><dt>Catálogo</dt><dd>${esc(r.cat)}</dd></div><div><dt>UPC</dt><dd>${esc(r.upc || 'Automático')}</dd></div>
        <div><dt>Sello</dt><dd>${esc(catalog.labels.find((l) => l.id === r.labelId)?.name ?? r.labelId)}</dd></div>
        <div><dt>Género</dt><dd>${esc(catalog.genres.find((g) => g.id === r.genreId)?.name ?? '—')}</dd></div>
        <div><dt>ID en el proveedor</dt><dd>${esc(r.provider?.releaseId ?? '—')}</dd></div></dl></section>
      <section class="section"><header><h2>Pistas</h2></header><table><thead><tr><th>#</th><th>Título</th><th>Audio</th><th>Autores</th></tr></thead><tbody>
        ${r.tracks.map((t) => `<tr><td>${t.num}</td><td>${esc(t.title)}</td><td>${esc(t.audio?.filename ?? '—')}</td><td>${esc(t.writers.map((w) => `${w.firstName} ${w.lastName} (${w.share}%)`).join(', '))}</td></tr>`).join('')}</tbody></table></section>
      <section class="section"><header><h2>Historial</h2></header><ul class="history">${[...r.history].reverse().map((h) => `<li><time>${fmtTime(h.at)}</time><span class="${h.ok ? '' : 'no'}">${esc(h.step)}${h.detail ? ` — ${esc(h.detail)}` : ''}</span></li>`).join('')}</ul></section>`;
    $('#refresh')?.addEventListener('click', () => views.detalle(id));
    $('#takedown')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Se solicitará retirar este lanzamiento de todas las plataformas. Puede tardar días en completarse.', 'Dar de baja'))) return;
      try { await api(`/releases/${id}/takedown`, { method: 'POST', body: {} }); toast('Baja solicitada'); views.detalle(id); } catch (e) { toast(e.message, true); }
    });
    $('#delete')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Se borrará el borrador y sus archivos. No se puede deshacer.', 'Borrar'))) return;
      try { await api(`/releases/${id}`, { method: 'DELETE' }); toast('Borrador borrado'); location.hash = '#/catalogo'; } catch (e) { toast(e.message, true); }
    });
    if (['processing', 'delivered'].includes(r.status)) schedule(() => views.detalle(id), 6000);
  },

  async regalias() {
    const [st, bd] = await Promise.all([api('/royalties/statements'), api('/royalties/breakdown')]);
    const tbl = (rows, h) => rows.length ? `<table><thead><tr><th>${h}</th><th class="num">Bruto (USD)</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${money(r.grossUsd)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Sin datos todavía.</div>';
    main.innerHTML = `<div class="head"><div><h1>Regalías</h1><p>Bruto total reportado: ${money(bd.totalGrossUsd)}. Las cifras brutas son antes de comisiones del proveedor.</p></div></div>
      <section class="section"><header><h2>Por mes</h2></header>${barChart(bd.byPeriod)}</section>
      <section class="section"><header><h2>Estados de cuenta</h2></header>${st.length ? `<table><thead><tr><th>Periodo</th><th>Estado</th><th class="num">Bruto</th><th class="num">Comisión</th><th class="num">Neto</th></tr></thead><tbody>
        ${st.map((s) => `<tr><td>${esc(s.period)}</td><td>${esc(s.status ?? '—')}</td><td class="num">${money(s.grossUsd)}</td><td class="num">${s.providerFee == null ? '—' : money(s.providerFee)}</td><td class="num">${s.amount == null ? '—' : money(s.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aún no hay estados de cuenta.</div>'}</section>
      <section class="section"><header><h2>Por plataforma</h2></header>${tbl(bd.byDsp, 'Plataforma')}</section>
      <section class="section"><header><h2>Por pista</h2></header>${tbl(bd.byTrack, 'Pista (ISRC o título)')}</section>`;
  },

  async conexion() {
    account = await api('/account').catch((e) => ({ error: e.message }));
    const hook = `${location.origin}/api/webhooks/labelgrid`;
    main.innerHTML = `<div class="head"><div><h1>Conexión</h1><p>Cómo se comunica este portal con el proveedor de entrega.</p></div></div>
      <section class="section"><header><h2>Proveedor</h2></header><dl class="meta">
        <div><dt>Adaptador activo</dt><dd>${esc(account.provider ?? '—')}</dd></div>
        <div><dt>Cuenta</dt><dd>${esc(account.name ?? account.email ?? '—')}</dd></div></dl>
        ${account.error ? `<div class="callout bad" style="margin-top:14px">${esc(account.error)}</div>` : ''}</section>
      <section class="section"><header><h2>Webhook de estado</h2></header><div class="stack">
        <p>Para ver los cambios de entrega al instante, registra esta URL como webhook en el proveedor. Debe ser pública (HTTPS) y apuntar a este servidor.</p>
        <p><code>${esc(hook)}</code></p>
        <p class="muted">Cada llamada se verifica con firma HMAC-SHA256 y se descarta si se repite. Sin webhook, el portal consulta el estado cada 15 segundos.</p></div></section>`;
  },

  async formulario(id) {
    const blankTrack = () => ({ title: '', compositionType: 'original_composition', audioLanguage: 'es', explicit: 'off', isrc: '', aiUsage: { audio: 'none', composition: 'none' }, writers: [{ firstName: '', lastName: '', roles: ['composer'], share: 100 }], audio: null });
    const model = id ? await api(`/releases/${id}`) : {
      title: '', titleLang: 'es', contentType: 'Single', labelId: catalog.labels[0]?.id, artists: [{ name: '', role: 'primary' }], cat: '', upc: '', genreId: null, explicit: 'off',
      releaseDate: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), outlets: catalog.outlets.map((o) => o.key), aiUsage: { artwork: 'none' }, tracks: [blankTrack()], cover: null,
    };
    let issues = null; let busy = false;

    const render = () => {
      const m = model;
      main.innerHTML = `<div class="head"><div><h1>${id ? 'Editar lanzamiento' : 'Nuevo lanzamiento'}</h1><p>Completa las secciones y envía a distribución cuando estés listo. Tras el envío, el audio y los datos quedan bloqueados.</p></div></div>
      <form id="rel" novalidate><div class="form-grid">
        <nav class="form-index" aria-label="Secciones"><a href="#s-datos" data-jump>Datos</a><a href="#s-artistas" data-jump>Artistas</a><a href="#s-pistas" data-jump>Pistas</a><a href="#s-plataformas" data-jump>Plataformas</a></nav>
        <div>
        <fieldset id="s-datos"><legend>Datos del lanzamiento</legend><div class="fields">
          <label class="f"><span>Título</span><input name="title" value="${esc(m.title)}" required></label>
          <label class="f"><span>Idioma del título</span><select name="titleLang">${opts(LANGS.slice(0, 4), m.titleLang)}</select></label>
          <label class="f"><span>Tipo</span><select name="contentType">${opts(['Single', 'EP', 'Album', 'Compilation', 'Mix'].map((x) => [x, x]), m.contentType)}</select></label>
          <label class="f"><span>Sello</span><select name="labelId">${opts(catalog.labels.map((l) => [l.id, l.name]), m.labelId)}</select></label>
          <label class="f"><span>Número de catálogo <small>(máx. 20)</small></span><input name="cat" maxlength="20" value="${esc(m.cat)}"></label>
          <label class="f"><span>UPC / EAN <small>(vacío = automático)</small></span><input name="upc" inputmode="numeric" value="${esc(m.upc)}"></label>
          <label class="f"><span>Género principal</span><select name="genreId"><option value="">Elige…</option>${opts(catalog.genres.map((g) => [g.id, g.name]), m.genreId)}</select></label>
          <label class="f"><span>Fecha de lanzamiento</span><input type="date" name="releaseDate" value="${esc(m.releaseDate?.slice(0, 10))}"></label>
          <label class="f"><span>Contenido explícito</span><select name="explicit">${opts([['off', 'No'], ['on', 'Sí'], ['edited', 'Versión editada']], m.explicit)}</select></label>
        </div>
        <div class="sub"><h3>Portada</h3><div class="fields"><label class="f"><span>Uso de inteligencia artificial en la portada</span><select name="ai_artwork">${opts(AI, m.aiUsage.artwork)}</select></label></div></div>
        <div class="sub"><div class="row">${m.cover || m._cover ? `<img class="cover" id="cover-prev" alt="" ${m._cover ? `src="${URL.createObjectURL(m._cover)}"` : `src="/api/releases/${m.id}/cover?t=${Date.now()}"`}>` : ''}
          <label class="f" style="flex:1"><span>Archivo JPG o PNG, cuadrado, mínimo 3000×3000 px</span><input type="file" id="cover" accept="image/jpeg,image/png"></label></div>
          ${m.cover && !m._cover ? `<small>Archivo actual: ${esc(m.cover.filename)}</small>` : ''}</div></fieldset>

        <fieldset id="s-artistas"><legend>Artistas</legend><div class="stack" id="artists">
          ${m.artists.map((a, i) => `<div class="repeat" data-i="${i}"><label class="f"><span>Nombre artístico</span><input data-a="name" value="${esc(a.name)}"></label>
            <label class="f"><span>Rol</span><select data-a="role">${opts(ROLES, a.role)}</select></label>
            <button type="button" class="btn small ghost" data-rm-artist="${i}" aria-label="Quitar artista" ${m.artists.length < 2 ? 'disabled' : ''}>×</button></div>`).join('')}
          <div><button type="button" class="btn small" id="add-artist">Agregar artista</button></div></div></fieldset>

        <fieldset id="s-pistas"><legend>Pistas</legend>
          ${m.tracks.map((t, i) => `<div class="sub" data-t="${i}"><div class="sub-head"><h3>Pista ${i + 1}</h3><button type="button" class="btn small ghost" data-rm-track="${i}" ${m.tracks.length < 2 ? 'disabled' : ''}>Quitar pista</button></div>
            <div class="fields">
              <label class="f"><span>Título</span><input data-k="title" value="${esc(t.title)}"></label>
              <label class="f"><span>Composición</span><select data-k="compositionType">${opts(COMP, t.compositionType)}</select></label>
              <label class="f"><span>Idioma del audio</span><select data-k="audioLanguage">${opts(LANGS, t.audioLanguage)}</select></label>
              <label class="f"><span>Explícito</span><select data-k="explicit">${opts([['off', 'No'], ['on', 'Sí'], ['edited', 'Editada']], t.explicit)}</select></label>
              <label class="f"><span>ISRC <small>(vacío = automático)</small></span><input data-k="isrc" value="${esc(t.isrc)}" placeholder="MXA012600001"></label>
              <label class="f"><span>IA en el audio</span><select data-k="ai_audio">${opts(AI, t.aiUsage.audio)}</select></label>
              <label class="f"><span>IA en la composición</span><select data-k="ai_composition">${opts(AI, t.aiUsage.composition)}</select></label>
            </div>
            <div><h3 style="margin-bottom:8px">Autores y compositores <small>(deben sumar 100%)</small></h3><div class="stack">
              ${t.writers.map((w, j) => `<div class="repeat writer" data-w="${j}"><label class="f"><span>Nombre</span><input data-w="firstName" value="${esc(w.firstName)}"></label><label class="f"><span>Apellido</span><input data-w="lastName" value="${esc(w.lastName)}"></label>
                <label class="f"><span>Rol</span><select data-w="role">${opts([['composer', 'Compositor'], ['lyricist', 'Letrista'], ['both', 'Ambos']], w.roles.length > 1 ? 'both' : w.roles[0])}</select></label>
                <label class="f"><span>%</span><input data-w="share" type="number" min="0" max="100" step="0.01" value="${w.share}"></label>
                <button type="button" class="btn small ghost" data-rm-writer="${i}:${j}" aria-label="Quitar autor" ${t.writers.length < 2 ? 'disabled' : ''}>×</button></div>`).join('')}
              <div><button type="button" class="btn small" data-add-writer="${i}">Agregar autor</button></div></div></div>
            <label class="f"><span>Audio — WAV o FLAC sin pérdida (16/24 bit)</span><input type="file" data-audio="${i}" accept=".wav,.flac,.mp3,audio/*"></label>
            <small>${t._audio ? `Listo para subir: ${esc(t._audio.name)}` : t.audio ? `Archivo actual: ${esc(t.audio.filename)}` : 'Sin audio'}</small></div>`).join('')}
          <button type="button" class="btn small" id="add-track">Agregar pista</button></fieldset>

        <fieldset id="s-plataformas"><legend>Plataformas de destino</legend>
          <div class="row" style="margin-bottom:10px"><button type="button" class="btn small" id="all-out">Todas</button><button type="button" class="btn small" id="no-out">Ninguna</button></div>
          <div class="outlets">${catalog.outlets.map((o) => `<label><input type="checkbox" name="outlet" value="${esc(o.key)}" ${m.outlets.includes(o.key) ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}</div></fieldset>

        <div id="issues" aria-live="polite">${issues ? renderIssues(issues) : ''}</div>
        <div class="sticky-bar"><button type="button" class="btn" id="save" ${busy ? 'disabled' : ''}>Guardar borrador</button><button type="button" class="btn" id="check" ${busy ? 'disabled' : ''}>Guardar y revisar</button>
          <button type="button" class="btn primary" id="send" ${busy ? 'disabled' : ''}>Enviar a distribución</button><progress id="prog" max="100" value="0" hidden></progress><span id="prog-label" class="muted"></span></div>
        </div></div></form>`;
      bind();
    };

    const renderIssues = (v) => (v.errors?.length || v.warnings?.length)
      ? `<ul class="issues">${(v.errors ?? []).map((e) => `<li class="e">${esc(e.message)}</li>`).join('')}${(v.warnings ?? []).map((e) => `<li class="w">${esc(e.message)}</li>`).join('')}</ul>`
      : '<div class="callout" style="border-color:var(--ok);background:var(--ok-soft)">Todo en orden: no hay errores ni avisos.</div>';

    const collect = () => {
      const f = $('#rel'); const g = (n) => f.elements[n]?.value ?? '';
      const m = model;
      Object.assign(m, { title: g('title'), titleLang: g('titleLang'), contentType: g('contentType'), labelId: +g('labelId') || null, cat: g('cat'), upc: g('upc'), genreId: +g('genreId') || null, releaseDate: g('releaseDate'), explicit: g('explicit'),
        aiUsage: { artwork: g('ai_artwork') }, outlets: $$('input[name=outlet]:checked', f).map((x) => x.value) });
      m.artists = $$('#artists .repeat', f).map((row) => ({ name: $('[data-a=name]', row).value, role: $('[data-a=role]', row).value }));
      m.tracks = $$('[data-t]', f).map((el) => {
        const prev = m.tracks[+el.dataset.t] ?? {}; const k = (n) => $(`[data-k=${n}]`, el).value;
        return { ...prev, title: k('title'), compositionType: k('compositionType'), audioLanguage: k('audioLanguage'), explicit: k('explicit'), isrc: k('isrc'), aiUsage: { audio: k('ai_audio'), composition: k('ai_composition') },
          writers: $$('.repeat.writer', el).map((row) => { const w = (n) => $(`[data-w=${n}]`, row).value; const role = w('role');
            return { firstName: w('firstName'), lastName: w('lastName'), roles: role === 'both' ? ['composer', 'lyricist'] : [role], share: +w('share') || 0 }; }) };
      });
    };
    const mutate = (fn) => { collect(); fn(); render(); };

    function bind() {
      const f = $('#rel');
      $$('[data-jump]', f).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth' }); }));
      $('#add-artist').onclick = () => mutate(() => model.artists.push({ name: '', role: 'featuring' }));
      $$('[data-rm-artist]', f).forEach((b) => (b.onclick = () => mutate(() => model.artists.splice(+b.dataset.rmArtist, 1))));
      $('#add-track').onclick = () => mutate(() => model.tracks.push(blankTrack()));
      $$('[data-rm-track]', f).forEach((b) => (b.onclick = () => mutate(() => model.tracks.splice(+b.dataset.rmTrack, 1))));
      $$('[data-add-writer]', f).forEach((b) => (b.onclick = () => mutate(() => model.tracks[+b.dataset.addWriter].writers.push({ firstName: '', lastName: '', roles: ['composer'], share: 0 }))));
      $$('[data-rm-writer]', f).forEach((b) => (b.onclick = () => mutate(() => { const [i, j] = b.dataset.rmWriter.split(':').map(Number); model.tracks[i].writers.splice(j, 1); })));
      $('#cover').onchange = (e) => { model._cover = e.target.files[0] ?? null; if (model._cover) { let img = $('#cover-prev'); if (!img) { img = Object.assign(document.createElement('img'), { id: 'cover-prev', className: 'cover', alt: '' }); e.target.closest('.row').prepend(img); } img.src = URL.createObjectURL(model._cover); } };
      $$('[data-audio]', f).forEach((inp) => (inp.onchange = () => { model.tracks[+inp.dataset.audio]._audio = inp.files[0] ?? null; inp.parentElement.nextElementSibling.textContent = inp.files[0] ? `Listo para subir: ${inp.files[0].name}` : ''; }));
      $('#all-out').onclick = () => $$('input[name=outlet]', f).forEach((x) => (x.checked = true));
      $('#no-out').onclick = () => $$('input[name=outlet]', f).forEach((x) => (x.checked = false));
      $('#save').onclick = () => run(false, false);
      $('#check').onclick = () => run(true, false);
      $('#send').onclick = () => run(true, true);
    }

    const putFile = (url, file, onp) => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('PUT', url);
      x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded / e.total);
      x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText || '{}').error || `Error ${x.status}`)));
      x.onerror = () => reject(new Error('Falló la conexión durante la subida.')); x.send(file);
    });

    async function run(check, send) {
      collect(); busy = true; $$('.sticky-bar .btn').forEach((b) => (b.disabled = true));
      const prog = $('#prog'); const lab = $('#prog-label');
      try {
        const body = { ...model }; delete body._cover;
        let saved = model.id ? await api(`/releases/${model.id}`, { method: 'PUT', body }) : await api('/releases', { method: 'POST', body });
        model.id = saved.id;
        const jobs = [];
        if (model._cover) jobs.push([`/api/releases/${saved.id}/cover?filename=${encodeURIComponent(model._cover.name)}`, model._cover, 'portada']);
        model.tracks.forEach((t, i) => { if (t._audio) jobs.push([`/api/releases/${saved.id}/tracks/${saved.tracks[i].id}/audio?filename=${encodeURIComponent(t._audio.name)}`, t._audio, `audio de la pista ${i + 1}`]); });
        for (const [n, [url, file, label]] of jobs.entries()) {
          prog.hidden = false; lab.textContent = `Subiendo ${label} (${n + 1}/${jobs.length})…`;
          await putFile(url, file, (p) => (prog.value = Math.round(p * 100)));
        }
        prog.hidden = true; lab.textContent = '';
        saved = await api(`/releases/${saved.id}`);
        Object.assign(model, saved); model._cover = null; model.tracks.forEach((t) => delete t._audio);
        if (check) {
          issues = await api(`/releases/${saved.id}/precheck`, { method: 'POST' });
          if (!send || !issues.ok) { busy = false; render(); $('#issues').scrollIntoView({ behavior: 'smooth' }); if (!check || (send && !issues.ok)) toast('Corrige los errores antes de enviar', true); else toast('Borrador guardado'); return; }
        }
        if (send) {
          if (!(await confirmDialog('Se subirán los archivos y se enviará el lanzamiento a las plataformas elegidas. Después no podrás cambiar el audio ni los datos.', 'Enviar'))) { busy = false; render(); return; }
          lab.textContent = 'Enviando al proveedor…';
          await api(`/releases/${saved.id}/submit`, { method: 'POST' });
          toast('Enviado a distribución'); location.hash = `#/lanzamiento/${saved.id}`; return;
        }
        toast('Borrador guardado'); busy = false; render();
      } catch (e) {
        busy = false; if (e.details) issues = e.details; render(); toast(e.message, true);
      }
    }
    render();
  },
};

// ---------- enrutador ----------
function schedule(fn, ms) { clearTimeout(timer); timer = setTimeout(fn, ms); }

async function route() {
  clearTimeout(timer);
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  const nav = { '': 'panel', catalogo: 'catalogo', regalias: 'regalias', conexion: 'conexion', lanzamiento: 'catalogo' }[parts[0] ?? ''] ?? 'panel';
  $$('[data-nav]').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  try {
    if (!catalog) catalog = await api('/catalog');
    if (!parts.length) await views.panel();
    else if (parts[0] === 'lanzamiento' && parts[1] === 'nuevo') await views.formulario();
    else if (parts[0] === 'lanzamiento' && parts[2] === 'editar') await views.formulario(parts[1]);
    else if (parts[0] === 'lanzamiento') await views.detalle(parts[1]);
    else if (views[parts[0]]) await views[parts[0]]();
    else await views.panel();
  } catch (e) {
    main.innerHTML = `<div class="head"><h1>No pudimos cargar esta pantalla</h1></div><div class="callout bad">${esc(e.message)}</div>
      <p style="margin-top:14px"><a href="#/conexion">Revisar la conexión con el proveedor</a></p>`;
  }
  main.focus({ preventScroll: true }); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
api('/health').then((h) => { $('#provider-badge').textContent = h.provider === 'mock' ? 'Modo demo (simulado)' : `Proveedor: ${h.provider}`; }).catch(() => {});
route();
