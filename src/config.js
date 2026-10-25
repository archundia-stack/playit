// Configuración leída del entorno. Un .env sencillo se carga sin dependencias.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function loadConfig(env = process.env) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));
  return {
    root: ROOT,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    provider: (env.PROVIDER ?? 'mock').toLowerCase(),
    labelgrid: {
      apiUrl: (env.LABELGRID_API_URL ?? 'https://api.labelgrid.com/api/public').replace(/\/+$/, ''),
      token: env.LABELGRID_TOKEN ?? '',
      webhookSecret: env.LABELGRID_WEBHOOK_SECRET ?? '',
    },
    dataFile: abs(env.DATA_FILE ?? './data/db.json'),
    uploadDir: abs(env.UPLOAD_DIR ?? './data/uploads'),
    publicDir: path.join(ROOT, 'public'),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 600 * 1024 * 1024),
  };
}

export function loadConfigFromProcess() {
  loadDotEnv(path.join(ROOT, '.env'));
  return loadConfig(process.env);
}
