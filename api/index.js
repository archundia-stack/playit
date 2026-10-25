// Entrada para Vercel: reutiliza la app de node:http como función serverless.
// Vercel sirve public/ como estático; aquí solo llegan /api/*.
// Limitaciones en Vercel: el disco es efímero (solo /tmp), el cuerpo de una petición
// no puede pasar de ~4.5 MB y no hay temporizadores entre peticiones (sin polling de 15 s).
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createProvider } from '../src/providers/provider.js';
import { createApp } from '../src/server.js';

const config = loadConfig({
  ...process.env,
  DATA_FILE: process.env.DATA_FILE ?? '/tmp/labelgrid/db.json',
  UPLOAD_DIR: process.env.UPLOAD_DIR ?? '/tmp/labelgrid/uploads',
});
const store = new Store(config.dataFile);
const cache = { get: (k) => store.getSetting(`lg:${k}`), set: (k, v) => store.setSetting(`lg:${k}`, v) };
const provider = createProvider(config, { cache });
const { server } = createApp({ config, store, provider, poll: false });

export default function handler(req, res) {
  server.emit('request', req, res);
}
