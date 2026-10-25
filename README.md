# Portal propio de distribución musical (prototipo)

Interfaz propia (catálogo, alta de lanzamientos, estado de entrega, regalías) con una **capa de entrega intercambiable**.
Hoy habla con LabelGrid; mañana puede hablar con otro mayorista escribiendo un adaptador nuevo.

- Node 20+ (probado en 22), **sin dependencias**: `npm install` no hace falta.
- Frontend en JS vanilla; backend HTTP con `node:http`; persistencia en JSON (`data/db.json`).

## Arranque rápido (modo demo, sin credenciales)

```bash
npm run start:mock        # http://127.0.0.1:3000
npm test                  # 28 pruebas
```

El modo demo simula el proveedor: la entrega avanza sola (en proceso → entregado → en vivo) y las regalías son **sintéticas**.

## Conectar LabelGrid

1. Contrata el plan con API y pide el **sandbox** (requiere dar de alta la IP del servidor).
2. Copia `.env.example` a `.env` y completa:
   ```
   PROVIDER=labelgrid
   LABELGRID_API_URL=<URL del sandbox o https://api.labelgrid.com/api/public>
   LABELGRID_TOKEN=<tu token>
   LABELGRID_WEBHOOK_SECRET=<secreto del webhook>
   ```
3. `npm start`, abre **Conexión** y comprueba que aparece tu cuenta.
4. Webhook: registra `https://TU-DOMINIO/api/webhooks/labelgrid` en LabelGrid (debe ser HTTPS público). Sin webhook, el portal consulta el estado cada 15 s.
5. Descarga `https://api.labelgrid.com/docs/api.json` y ejecuta `npm run check:spec -- api.json` para confirmar que el adaptador sigue alineado.

El token vive solo en el servidor; el navegador nunca lo ve.

## Arquitectura

```
public/            SPA (panel, catálogo, formulario, detalle con "carril de señal", regalías, conexión)
src/server.js      HTTP + rutas /api + webhook (cuerpo crudo)
src/services/      releases (flujo de envío), royalties, webhooks (idempotencia)
src/domain/        validación local previa al envío
src/providers/
  provider.js      contrato que cumple cualquier mayorista
  labelgrid.js     cliente + adaptador (subida presignada, polling, reintentos GET, 429)
  labelgrid-mappers.js   traducción pura portal <-> API (aquí vive todo lo específico de LabelGrid)
  mock.js          proveedor simulado
```

Flujo de envío: validación local → sincronizar borrador remoto (artistas, autores, release, pistas; `PATCH` si ya existe) →
subir portada y audio (URL presignada → registro → polling) → validar en el proveedor → distribuir → seguir el estado.
Tras el envío el audio y los datos quedan bloqueados (igual que en LabelGrid).

## Qué se verificó y qué no

**Verificado contra el OpenAPI real de LabelGrid** (leído el 24-oct-2026): los 23 endpoints usados existen; los cuerpos de
`POST /releases`, `PATCH /releases/{id}`, `POST /tracks`, `/artists`, `/writers` traen todos los campos requeridos, no incluyen campos
desconocidos y los enums son válidos. (Esta comprobación corrió y detectó un error real: `audio_ai_usage` / `composition_ai_usage`
no existen a nivel de release.) Repite con `npm run check:spec -- api.json`.

**Probado con un LabelGrid falso** (`test/fake-labelgrid.js`): flujo completo, PATCH sin duplicar, borrado de pistas, 202 + polling de audio,
429 de límite semanal, 403 de campos bloqueados, 401, reintentos de GET, paginación por cursor, token solo en cabecera.
El falso lo escribí yo a partir del OpenAPI: demuestra la lógica del adaptador, **no** el comportamiento real de LabelGrid.

**Webhooks:** HMAC-SHA256 sobre el cuerpo crudo, comparación en tiempo constante, ventana de 5 min con el `timestamp` del cuerpo firmado,
idempotencia por evento + ids. Siguen el contrato documentado por LabelGrid; no se probaron con un webhook real.

### Pendiente de verificar en el sandbox (supuestos marcados en el código)

| Supuesto | Dónde cambiarlo |
|---|---|
| Forma del objeto `roles` de writers/contributors (se envía `{"Composer": true}`; el esquema solo dice "object") | `rolesObject()` en `labelgrid-mappers.js` |
| Valores de `artistic_role` (`Primary`, `Featuring`, `Remixer`; el esquema dice "string") | `ARTIST_ROLE_MAP` |
| Valores de `state`/`customer_state` en delivery-status (se normaliza por palabras clave) | `normalizeState()` |
| Valores de `status` de los intentos de subida | `#waitUpload()` en `labelgrid.js` |
| Valores válidos de `group_by` en `/royalties/breakdown` (se usa `dsp`) | `getBreakdown()` |
| Forma de la respuesta de `POST /releases` y `POST /tracks` (se lee `id` o `data.id`) | `syncRelease()` |
| Forma de `GET /me` (se lee `name`/`email`) | `getAccount()` |

## Lo que falta para producción

- **Autenticación y roles de usuario** (hoy no hay login: escucha en 127.0.0.1 y rechaza orígenes ajenos; no lo expongas a internet así).
- Base de datos real (PostgreSQL) y almacenamiento de archivos en la nube en lugar de disco local.
- Multi-tenant (varios sellos/clientes), con aislamiento de datos y credenciales por cliente.
- Motor de regalías propio: hoy solo se **leen** estados de cuenta y desglose del proveedor; no hay reparto a artistas, retenciones ni pagos.
- Cola de trabajos para subidas largas y reintentos; observabilidad; respaldo.
- Validación de audio/portada (formato, resolución, loudness) antes de enviar.
- Adaptador de un segundo mayorista para probar que la capa es realmente intercambiable.
