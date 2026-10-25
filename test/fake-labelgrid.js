// Servidor que imita los endpoints de LabelGrid usados por el adaptador. Rechaza peticiones
// sin los campos requeridos del OpenAPI, así los tests detectan mapeos incompletos.
import http from 'node:http';

export async function startFakeLabelGrid({ token = 'tok_test' } = {}) {
  const state = { artists: [], writers: [], releases: {}, tracks: {}, calls: [], nextId: 1000, failNextGet: 0, limit429: false, uploads: [], attemptsPolled: 0 };
  const id = () => ++state.nextId;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const body = isJson && raw.length ? JSON.parse(raw) : null;
    const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    const path = url.pathname.replace(/^\/api\/public/, '');
    state.calls.push({ method: req.method, path, body, auth: req.headers.authorization });

    if (path.startsWith('/__s3/')) { state.uploads.push({ path, bytes: raw.length }); return send(200); }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Unauthenticated.' });
    if (req.method === 'GET' && state.failNextGet > 0) { state.failNextGet--; return send(503, { message: 'busy' }); }
    const missing = (obj, keys) => keys.filter((k) => obj?.[k] === undefined || obj?.[k] === null || obj?.[k] === '');
    const m = (re) => path.match(re);
    let x;

    if (req.method === 'GET' && path === '/me') return send(200, { id: 1, name: 'Sello Demo', email: 'demo@labelgrid.test' });
    if (req.method === 'GET' && path === '/labels') return send(200, { data: [{ id: 7, name: 'Mi Sello' }], meta: { current_page: 1, last_page: 1 } });
    if (req.method === 'GET' && path === '/genres') return send(200, [{ id: 3, name: 'Pop', category: null, base_genre: null }]);
    if (req.method === 'GET' && path === '/distro-outlets') return send(200, [{ id: 1, key: 'spotify', name: 'Spotify', type: 'store', is_ai_dsp: false, is_ugc_store: false }, { id: 2, key: 'youtube-ugc', name: 'YT UGC', type: 'ugc', is_ai_dsp: false, is_ugc_store: true }]);
    if (req.method === 'GET' && path === '/artists') return send(200, { data: state.artists, meta: { current_page: 1, last_page: 1 } });
    if (req.method === 'GET' && path === '/writers') return send(200, { data: state.writers, meta: { current_page: 1, last_page: 1 } });
    if (req.method === 'POST' && path === '/artists') {
      if (missing(body, ['artist_name']).length || body.artist_name.length < 2) return send(422, { message: 'artist_name inválido' });
      const a = { id: id(), artist_name: body.artist_name }; state.artists.push(a); return send(201, a);
    }
    if (req.method === 'POST' && path === '/writers') {
      if (missing(body, ['last_name']).length) return send(422, { message: 'last_name requerido' });
      const w = { id: id(), first_name: body.first_name ?? null, last_name: body.last_name }; state.writers.push(w); return send(201, w);
    }
    if (req.method === 'POST' && path === '/releases') {
      if (state.limit429) return send(429, { code: 'release_submission_limit_exceeded', message: 'Weekly limit' }, { 'retry-after': '3600' });
      const miss = missing(body, ['content_type', 'label_id', 'artists', 'titles', 'cat', 'artwork_ai_usage', 'primary_genre_id']);
      if (miss.length) return send(422, { message: `faltan: ${miss.join(', ')}` });
      if (!body.artists.every((a) => Number.isInteger(a.artist_id) && a.artistic_role)) return send(422, { message: 'artists mal formados' });
      const r = { id: id(), ...body }; state.releases[r.id] = r; return send(201, { id: r.id });
    }
    if ((x = m(/^\/releases\/(\d+)$/)) && req.method === 'PATCH') {
      const r = state.releases[x[1]]; if (!r) return send(404, { message: 'no existe' });
      if ('content_type' in body) return send(403, { code: 'RELEASE_LOCKED_FIELDS', message: 'content_type es inmutable' });
      Object.assign(r, body); return send(200, { id: r.id });
    }
    if ((x = m(/^\/releases\/(\d+)\/photo$/)) && req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) return send(422, { message: 'multipart requerido' });
      return send(200, { filename: 'cover.png', url: 'https://cdn/x' });
    }
    if (req.method === 'POST' && path === '/tracks') {
      const miss = missing(body, ['release_id', 'disc', 'track_num', 'composition_type', 'artists', 'audio_ai_usage', 'composition_ai_usage', 'commercial_samples', 'audio_language', 'contributors']);
      if (miss.length) return send(422, { message: `faltan: ${miss.join(', ')}` });
      if (!state.releases[body.release_id]) return send(422, { message: 'release_id inexistente' });
      const t = { id: id(), ...body }; state.tracks[t.id] = t; return send(201, { id: t.id });
    }
    if ((x = m(/^\/tracks\/(\d+)$/)) && req.method === 'PATCH') { Object.assign(state.tracks[x[1]] ?? {}, body); return send(200, { id: +x[1] }); }
    if ((x = m(/^\/tracks\/(\d+)$/)) && req.method === 'DELETE') { delete state.tracks[x[1]]; return send(204); }
    if ((x = m(/^\/tracks\/(\d+)\/files\/stereo\/upload-url$/)) && req.method === 'POST') {
      if (!body?.filename) return send(422, { message: 'filename requerido' });
      return send(200, { upload_url: `http://127.0.0.1:${server.address().port}/__s3/${x[1]}`, key: `uploads/${x[1]}/${body.filename}`, expires_in: 900 });
    }
    if ((x = m(/^\/tracks\/(\d+)\/files\/stereo$/)) && req.method === 'PUT') {
      if (!body?.s3_key) return send(422, { message: 's3_key requerido' });
      return send(202, { upload_attempt: { id: 'att1', status: 'processing', status_url: 'x', poll_after_seconds: 0 } });
    }
    if ((x = m(/^\/tracks\/(\d+)\/file-upload-attempts\/att1$/)) && req.method === 'GET') {
      state.attemptsPolled++; return send(200, { upload_attempt: { id: 'att1', status: state.attemptsPolled >= 2 ? 'completed' : 'processing', poll_after_seconds: 0 } });
    }
    if ((x = m(/^\/releases\/(\d+)\/validate$/)) && req.method === 'POST') return send(200, { result: 'OK', errors: [], errors_structured: [], warnings: ['x'], warnings_structured: [{ code: 'W1', entity_type: 'release', entity_id: +x[1], field: 'explicit', message: 'Revisa explicit' }] });
    if ((x = m(/^\/releases\/(\d+)\/distribute$/)) && req.method === 'POST') { state.releases[x[1]].distributed = true; return send(200, { message: 'ok', status: 'pending' }); }
    if ((x = m(/^\/releases\/(\d+)\/takedown-all$/)) && req.method === 'POST') return send(200, { message: 'takedown queued' });
    if ((x = m(/^\/releases\/(\d+)\/delivery-status$/)) && req.method === 'GET') {
      return send(200, { release_id: +x[1], state: 'in_progress', currently_live: false, ever_submitted: true, ever_delivered: false,
        outlets: [{ outlet: 'spotify', state: 'delivered', customer_state: 'delivered', updated_at: '2026-10-24T10:00:00Z' }, { outlet: 'apple-music', state: 'failed', customer_state: 'needs_attention', customer_action_code: 'FIX_ART', action_url: 'https://app/fix', error_code: 'ART_001' }] });
    }
    if (req.method === 'GET' && path === '/statements') return send(200, { data: [{ invoice_number: 'INV-1', period: '2026-09', scope: 'account', release_id: null, currency: 'USD', gross_usd: 120.5, amount: 100, labelgrid_fee: 20.5, status: 'paid' }], meta: {} });
    if (req.method === 'GET' && path === '/royalties/breakdown') {
      if (!url.searchParams.get('group_by')) return send(422, { message: 'group_by requerido' });
      const cursor = url.searchParams.get('cursor');
      return send(200, { data: [{ isrc: 'MXA012600001', dsp: 'spotify', dsp_name: 'Spotify', report_type: 'stream', release_id: 1001, territory: 'MX', period: '2026-09', currency: 'USD', gross_usd: cursor ? 2 : 3, adjustment: false }], meta: { next_cursor: cursor ? null : 'c2', total_gross_usd: 5 } });
    }
    return send(404, { message: `sin ruta: ${req.method} ${path}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}/api/public`, token, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
