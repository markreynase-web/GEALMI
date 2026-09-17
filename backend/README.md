# Backend — Ventas, Inventario y Clientes (Node.js + Express + PostgreSQL)

API con CRUD reutilizable (`src/crudFactory.js`): cada módulo declara sus
columnas en `src/routes/<modulo>.js` y obtiene automáticamente
GET/POST/PUT/DELETE + importación de CSV. Los tres módulos migrados hasta
ahora son Ventas, Inventario y Clientes; el dashboard (`../pages/<modulo>.html`)
usa la API automáticamente si la encuentra disponible, y si no, sigue
funcionando en modo local (CSV/localStorage) como en las Fases 1-2.

## 1. Requisitos

- Node.js 18 o superior.
- PostgreSQL corriendo en algún lado (tu máquina, o un proveedor gratuito
  como [Neon](https://neon.tech), [Supabase](https://supabase.com) o Railway).

## 2. Instalar dependencias

```bash
cd backend
npm install
```

## 3. Configurar la base de datos

Copia el archivo de ejemplo y edítalo con tus datos:

```bash
cp .env.example .env
```

```
DATABASE_URL=postgresql://usuario:password@localhost:5432/dashboard_core
PORT=3001
CORS_ORIGIN=http://localhost:8000
```

- `DATABASE_URL`: si usas PostgreSQL local, crea la base primero:
  `createdb dashboard_core` (o `psql -c "CREATE DATABASE dashboard_core;"`).
  Si usas Neon/Supabase/Railway, copian el `DATABASE_URL` ya armado en su panel.
- `CORS_ORIGIN`: la URL donde sirves el frontend. Si lo corres con
  `python -m http.server 8000` desde la raíz del proyecto, es
  `http://localhost:8000`.

## 4. Crear las tablas

```bash
npm run migrate
```

Esto ejecuta todo lo que hay en `migrations/*.sql`, en orden. Cuando se migre
otro módulo (Inventario, Clientes, etc.) a base de datos, su tabla entra como
un nuevo archivo ahí — no hace falta tocar este script.

## 5. Arrancar el servidor

```bash
npm run dev      # con recarga automática al guardar cambios
# o
npm start        # sin recarga, para "producción" casera
```

Deberías ver `API de Ventas escuchando en http://localhost:3001`.

## 6. Conectar el frontend

Desde Fase A (multi-tenant) la URL del backend ya no vive en un archivo por
cliente -- es una constante fija en `../js/apiConfig.js` (`API_BASE_URL`),
porque un solo backend atiende a todas las empresas. Si cambiaste el puerto o
vas a desplegar el backend en otro lugar, actualiza esa constante ahí.

Con el backend corriendo, abre el frontend normalmente
(`python -m http.server 8000` en la raíz del proyecto) y entra a
`pages/ventas.html`: debería aparecer el panel "Captura de datos" arriba del
dashboard, con el formulario "Nueva venta" y el botón para importar CSV
directo a la base de datos. Si el backend no está corriendo, ese panel
simplemente no aparece y la página funciona como antes (modo local).

## Autenticación (Fase 4) + multi-tenant (Fase A)

No hay pantalla de registro: el primer usuario (admin) se crea desde la terminal.

```bash
cd backend
npm run seed:admin -- "Tu Nombre" tu@email.com tuContraseña ["Nombre de la empresa"]
```

Si el email ya existe, el comando actualiza su nombre y contraseña (sirve
para resetear la clave del admin si la olvidas). El cuarto argumento
(nombre de empresa) es opcional -- sin él, reusa la primera empresa que
exista en `empresas` (o crea una si la base está vacía).

Con eso puedes loguearte en `pages/login.html`. Endpoints:

| Método | Ruta              | Qué hace |
|---|---|---|
| POST   | `/api/auth/login` | `{ email, password }` → `{ token, usuario }` si el usuario pertenece a una sola empresa, o `{ requiereSeleccionEmpresa: true, preAuthToken, empresas }` si pertenece a varias |
| POST   | `/api/auth/login/empresa` | `{ preAuthToken, empresa_id }` → `{ token, usuario }`. Segundo paso del login cuando hay más de una empresa; el `empresa_id` se revalida server-side contra `usuario_empresa`, nunca se confía a ciegas |
| GET    | `/api/auth/me`    | Requiere `Authorization: Bearer <token>`. Confirma que el token es válido |
| GET    | `/api/empresa/actual` | Requiere sesión. Devuelve branding + módulos habilitados de la empresa activa del token (reemplaza al viejo `config/company.json`) |

**Multi-tenant (Fase A):** el JWT lleva `empresa_id`/`empresa_nombre` además
de `rol`/`permisos` -- ambos se calculan a partir de la membresía
`usuario_empresa`, no de la identidad global en `usuarios` (una misma
persona puede tener rol distinto en cada empresa a la que pertenece). Toda
ruta de datos usa `auth() + requireEmpresa()` (ver
`src/middleware/auth.js`): un token sin `empresa_id` (de antes de este
deploy, o un `preAuthToken`) responde 401 en vez de devolver datos vacíos en
silencio. El aislamiento entre empresas vive en cada `WHERE empresa_id=...`
de `crudFactory.js` y de las rutas manuales (`ventas.js`, `inventario.js`,
`finanzas.js`, `usuarios.js`, `auditoria.js`) -- ver
`backend/migrations/012_empresas.sql` para el esquema completo
(`empresas`, `modulos`, `empresa_modulos`, `usuario_empresa`).

## Panel de super administrador

`usuarios.es_super_admin` es una bandera global, separada del sistema de
roles por empresa a propósito -- gestiona empresas enteras, no datos dentro
de una. El primer super admin se crea por terminal (huevo-y-gallina: para
crear uno desde la API hace falta ya serlo):

```bash
npm run seed:superadmin -- "Tu Nombre" tu@email.com tuContraseña
```

Si esa cuenta hace login, **nunca** pasa por la resolución de empresas de
`POST /api/auth/login` -- el token sale directo, sin `empresa_id` ni
`permisos`, solo `es_super_admin: true` (v1: exclusivo, no hay selector de
"entro como super admin" vs "entro como empresa X" aunque la cuenta también
tenga membresías normales). Frontend en `pages/superadmin.html`.

Rutas en `routes/superadmin.js`, protegidas con `auth() + requireSuperAdmin()`
(no `requireEmpresa()` -- cruzan empresas a propósito):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/superadmin/empresas` | Todas las empresas + conteo de usuarios y módulos habilitados |
| POST | `/api/superadmin/empresas` | `{ nombre, logo? }` |
| PUT | `/api/superadmin/empresas/:id` | `{ nombre?, logo?, activo?, color_primario? }` -- `color_primario` es la excepción: si no viene en el body se deja igual, pero si viene como `null`/vacío se borra a propósito (no usa `COALESCE`, ver el comentario en el código). |
| GET | `/api/superadmin/modulos` | Catálogo completo de `modulos` |
| GET | `/api/superadmin/empresas/:id/modulos` | Catálogo + flag `habilitado` para esa empresa |
| POST | `/api/superadmin/empresas/:id/modulos` | `{ modulo_id }` → habilita |
| DELETE | `/api/superadmin/empresas/:id/modulos/:moduloId` | Deshabilita |
| POST | `/api/superadmin/empresas/:id/admin` | `{ nombre, email, password? }` → crea (o reusa si el email ya existe globalmente) un usuario y lo vincula como `administrador` de esa empresa. A diferencia de `POST /api/usuarios` (que rechaza un email ya existente para no vincular sin consentimiento), acá SÍ se reusa a propósito: es el super admin pidiendo explícitamente esa acción, no un efecto secundario de un formulario común. |

**Personalización de marca por empresa** (`empresas.color_primario`, migración
`018_empresa_tema.sql`): un solo color hex, opt-in, que el super admin fija
desde el panel de "Gestionar empresa". El frontend lo aplica sobreescribiendo
las variables CSS `--ochre`/`--ochre-deep` (`aplicarTema()` en `js/config.js`,
llamada automáticamente dentro de `cargarConfigEmpresa()` -- así ninguna
página nueva puede olvidarse de aplicarlo, mismo problema que ya pasó con el
widget de GEALMI AI). El tono oscuro (`--ochre-deep`, usado en hover/estados
activos) se deriva del color elegido, no se pide aparte. Sin color guardado,
queda el amarillo de GEALMI de siempre. A propósito es solo un color, no
un editor de layout -- personalizar qué se muestra o cómo se organiza la UI
queda fuera de alcance.

## Usando Supabase como base de datos

Si tu `DATABASE_URL` apunta a Supabase, hay dos cosas propias de Supabase que
no aplican a un Postgres genérico:

1. **SSL obligatorio**: ya viene resuelto en `src/db.js` (usa
   `ssl: { rejectUnauthorized: false }` salvo que pongas `PGSSL=false` en `.env`,
   para el caso de Postgres local sin SSL).
2. **PostgREST (la API REST automática de Supabase)**: Supabase expone
   *cada tabla* como endpoint REST en `https://<proyecto>.supabase.co/rest/v1/<tabla>`,
   protegido solo por Row Level Security (RLS). Como este proyecto ya controla
   el acceso en el backend Express (`auth()` + `verificarPermiso()`), la
   migración `007_supabase_rls.sql` activa RLS **sin políticas** sobre todas
   las tablas -- eso cierra por completo el acceso vía `anon`/`authenticated`
   (los roles que usa PostgREST), y deja como única puerta de entrada nuestra
   propia API. El backend sigue funcionando normal porque se conecta con el
   rol `postgres` (con `BYPASSRLS`), así que esto no le cambia nada a
   `crudFactory.js` ni a ninguna ruta.

   **Corre `npm run migrate` con esta versión aunque ya hayas corrido las
   migraciones anteriores** -- si no, tus tablas se quedan expuestas por
   PostgREST con la `anon key` (que vive en el frontend, es pública por
   diseño) y cualquiera podría leer/escribir `ventas`/`clientes`/etc. saltándose
   todo el sistema de roles y permisos.

3. **Puerto de conexión**: usa el puerto **5432** (conexión directa), no el
   **6543** (pooler transaccional de PgBouncer) -- este backend es un proceso
   de larga duración (no serverless) y el `import` de CSV usa `BEGIN/COMMIT`
   sobre la misma conexión, que el pooler en modo transaccional no siempre
   maneja bien entre requests distintos.



Ya no es un simple `if (usuario.rol == 'admin')`. Hay tres tablas
(`roles`, `permisos`, `rol_permiso`, migración `005_roles_permisos.sql`) y
cada ruta de `crudFactory.js` exige un permiso concreto:

| Verbo  | Permiso exigido       |
|---|---|
| GET    | `{modulo}.ver`        |
| POST   | `{modulo}.crear`      |
| PUT    | `{modulo}.editar`     |
| DELETE | `{modulo}.eliminar`   |
| POST /import | `{modulo}.crear` |

Pipeline real: `Cliente → JWT → auth() → verificarPermiso() → CRUD Factory → PostgreSQL`.
Al hacer login, `routes/auth.js` calcula los permisos del rol del usuario
(join `roles → rol_permiso → permisos`) y los mete dentro del JWT — así
`verificarPermiso()` no necesita ir a la base de datos en cada request
(trade-off: si le quitas un permiso a un rol, a quien ya tenía sesión iniciada
le sigue funcionando hasta que su token expire a las 8h o vuelva a entrar).

Roles que trae la migración por defecto: `administrador` (todo), `gerente`
(ver/crear/editar en todo, sin eliminar ni usuarios), `ventas` (su módulo +
ver clientes), `inventario` (su módulo), `supervisor` (solo ver, en todo) y
`consulta` (solo ver ventas/inventario/clientes). Se editan agregando o
quitando filas de `rol_permiso` — no hace falta tocar código.

### Gestión de usuarios

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/api/usuarios` | `usuarios.ver` | Lista los usuarios miembros de la empresa activa (nombre, email, rol, activo) |
| GET | `/api/usuarios/roles` | `usuarios.ver` | Lista roles con sus permisos (catálogo global) |
| POST | `/api/usuarios` | `usuarios.crear` | `{ nombre, email, password, rol }`. Si el email ya tiene cuenta (en esta empresa o en otra) responde 409 en vez de vincularlo en silencio -- sin un flujo de invitación por correo (fuera de alcance de Fase A), auto-vincular dejaría que un admin "adopte" sin consentimiento la cuenta de alguien que ya trabaja en otra empresa |
| PUT | `/api/usuarios/:id` | `usuarios.editar` | `{ nombre?, rol?, activo? }` — `rol`/`activo` editan la membresía (`usuario_empresa`) scoped a la empresa activa, no la cuenta global; `nombre` sí es global (mismo nombre en todas las empresas donde participa esa persona) |
| DELETE | `/api/usuarios/:id` | `usuarios.eliminar` | Quita la membresía a la empresa activa (`usuario_empresa`), **no** borra la identidad global (`usuarios`) -- la persona puede pertenecer a otras empresas. Solo `administrador` lo tiene (mismo criterio que el resto de la app: `gerente` nunca recibe permisos `.eliminar`, ver `backend/migrations/017_usuarios_eliminar.sql`). Nadie puede eliminarse a sí mismo (400). |

### Registro de actividad (audit log)

Cada `crear`/`editar`/`eliminar`/`importar` exitoso en cualquier módulo con
`crudFactory` deja una fila en `audit_log` (migración `006_auditoria.sql`) sola,
sin que cada ruta tenga que acordarse de escribirla:

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/api/auditoria?modulo=&desde=&hasta=&limite=` | `auditoria.ver` | Lista el historial (quién, qué acción, qué módulo, cuándo) |

## Vertical automotriz (Fase C)

Primer vertical de industria, opt-in por empresa (ver
`backend/migrations/014_vertical_automotriz.sql` -- agrega `vehiculos`,
`repuestos`, `postventa` al catálogo de `modulos`, pero no los habilita
para ninguna empresa existente).

| Módulo | POST | GET/PUT/DELETE/import |
|---|---|---|
| `vehiculos` | Manual (resuelve `cliente_nombre`, ver `routes/vehiculos.js`) | GET/DELETE/import genéricos (`crudFactory`); PUT manual por el mismo motivo que POST |
| `repuestos` | Manual (genera un egreso en Finanzas si hay stock inicial, igual que `inventario.js`) | GET/PUT/import genéricos; DELETE manual (limpia el egreso) |
| `postventa` | Manual (transacción: descuenta stock del repuesto principal si se eligió uno, calcula `total`) | Todo manual (no usa `crudFactory` en absoluto, mismo patrón que `ventas.js`) -- no tiene `POST /import` |

`postventa.repuesto_id` es opcional y, si se usa, **inmutable después de
creada la orden** (igual que `ventas.js` no deja cambiar `producto_id` en un
PUT) -- corregir una elección equivocada es borrar y recrear la orden.
`costo_repuestos` siempre queda editable a mano (no hay líneas múltiples de
repuestos por orden), `mano_obra` siempre manual, `total` siempre calculado
en el servidor.

**De paso, un bug real en `crudFactory.js` que esta fase encontró y
arregló:** el PUT genérico trataba cualquier columna ausente del body como
"vacía" y la reseteaba a `null`/`0` -- cualquier edición inline que no
tocara TODAS las columnas de un módulo borraba en silencio las que se
quedaban afuera. Ya afectaba a `clientes.direccion`/`notas`, pero
`repuestos` tiene 5 columnas así (`compatibilidad`, `ubicacion`,
`tiempo_reposicion_dias`, `equivalencias`, `notas`), lo que lo hizo
imposible de ignorar. Arreglado: un PUT (`limpiarYValidar(body, {esEdicion:
true})`) ahora excluye del `UPDATE` cualquier columna que no venga en el
body, en vez de resetearla.

## GEALMI AI (Fase D)

Asistente de IA (Claude, vía la API de Anthropic) con acceso de solo lectura
a los datos de la empresa activa, opt-in por empresa igual que el resto de
módulos (creado originalmente como `khipu_ai` en
`backend/migrations/016_khipu_ai.sql` -- sin habilitarlo para ninguna
empresa existente -- y renombrado a `gealmi_ai` en
`backend/migrations/041_rename_khipu_ai_a_gealmi_ai.sql`; la 016 no se toca
porque ya corrió en producción). Se accede desde el frontend como un widget
flotante en toda la app, no una página de módulo (ver
`components/gealmiAiWidget.js`).

Un solo endpoint sirve tanto preguntas sueltas del usuario como resúmenes
automáticos -- son la misma llamada con distinto mensaje de entrada:

- `POST /api/gealmi-ai/preguntar` (`{ pregunta, historial? }`, requiere
  `gealmi_ai.ver`) corre un loop agentic manual: Claude recibe un set de
  "herramientas de datos" (`backend/src/gealmiAiTools.js` -- consultas SQL
  parametrizadas y scoped a `empresa_id`, nunca SQL libre), decide cuáles
  necesita, el backend las ejecuta y le devuelve el resultado, y Claude
  arma la respuesta final en español. El set de herramientas se arma según
  qué módulos tiene habilitados la empresa (ej. sin `repuestos` habilitado,
  Claude ni ve esas herramientas).
- **Generación en vivo, sin caché**: cada pregunta es una llamada real y
  facturada a la API de Claude (modelo `claude-sonnet-5`) -- decisión
  informada, se prioriza frescura sobre costo. Requiere la env var
  `ANTHROPIC_API_KEY`; sin ella, el endpoint responde 500 con un mensaje
  claro en vez de tumbar el resto del backend.
- Límite de abuso/costo: 40 preguntas por usuario por día (contador en
  memoria del proceso, se resetea a medianoche o si el servidor reinicia).
- El historial de la conversación vive en el navegador (nada se persiste en
  el servidor) -- coherente con "generación en vivo".

## Endpoints

Los mismos 5 endpoints existen para cada módulo: `ventas`, `inventario`,
`clientes`, `finanzas`. Todos scoped por `empresa_id` (Fase A): cada uno
solo ve/afecta los registros de la empresa activa del token, aunque el
`:id` de otra empresa exista en la base (responde 404, no 403).

| Método | Ruta                       | Qué hace |
|---|---|---|
| GET    | `/api/salud`               | Chequeo de vida (usado por el frontend para saber si conectarse) |
| GET    | `/api/{modulo}`            | Lista registros. Filtros opcionales `?desde=AAAA-MM-DD&hasta=AAAA-MM-DD` |
| POST   | `/api/{modulo}`            | Crea un registro (usado por el formulario) |
| PUT    | `/api/{modulo}/:id`        | Edita un registro (reemplaza todos los campos, como cualquier PUT) |
| DELETE | `/api/{modulo}/:id`        | Borra un registro |
| POST   | `/api/{modulo}/import`     | Importa un CSV (`multipart/form-data`, campo `archivo`) |

Columnas esperadas en el CSV de cada módulo (insensible a mayúsculas):
- **ventas**: `fecha, producto, categoria, cantidad, precio_unitario, cliente, notas` (`monto` opcional, se calcula si no viene)
- **inventario**: `fecha_registro, nombre, categoria, stock, stock_minimo, precio_unitario, notas`
- **clientes**: `fecha_registro, nombre, email, telefono, direccion, compras_totales, notas`
- **repuestos**: `fecha_registro, nombre, codigo_oem, compatibilidad, ubicacion, proveedor, tiempo_reposicion_dias, equivalencias, stock, stock_minimo, costo_unitario, precio_unitario, notas`
- **vehiculos**: igual que sus campos del formulario, pero además necesita `cliente_nombre` en el CSV -- el import genérico no puede resolverlo a partir de `cliente_id` como sí hace el formulario de la UI (ver tabla de arriba). `postventa` no tiene import de CSV (es 100% manual, como `ventas`).

## Cómo migrar un módulo nuevo (ej. Compras) a este mismo patrón

1. **Migración SQL** en `migrations/00N_compras.sql` — la tabla, con al menos
   `id SERIAL PRIMARY KEY`, una columna de fecha, y `actualizado_el TIMESTAMPTZ
   NOT NULL DEFAULT now()` (la usa `crudFactory.js` en cada UPDATE).
2. **Ruta** en `src/routes/compras.js`:
   ```js
   import { crearRouterCRUD } from '../crudFactory.js';
   export default crearRouterCRUD({
     tabla: 'compras',
     modulo: 'compras', // usado para permisos (compras.ver/crear/editar/eliminar) y para el audit log
     columnas: [...],
     camposRequeridos: [...],
     camposNumericos: [...],
     columnaFecha: 'fecha'
   });
   ```
   `empresa_id` sale gratis: `crudFactory.js` ya lo agrega solo a cada
   GET/POST/PUT/DELETE/import (Fase A) -- no lo agregues a `columnas`, o
   quedaría escribible desde el body de la request.
3. **Montarla** en `src/server.js`: `app.use('/api/compras', comprasRouter)`.
4. **Permisos**: agrega `compras.ver/crear/editar/eliminar` a la tabla `permisos`
   y asígnalos a los roles que correspondan en `rol_permiso` (mismo patrón que
   `005_roles_permisos.sql`).
5. **Esquema del frontend** en `../js/esquemas.js`: mismo formato que `ventas`/`inventario`/`clientes` (campos del formulario + columnasTabla + mapa hacia el dashboard).
6. **Activarlo**: agrega el módulo a la tabla `modulos` (si es nuevo) y una
   fila en `empresa_modulos` por cada empresa que lo tenga habilitado (ver
   `backend/migrations/012_empresas.sql`) -- ya no se edita un archivo, es
   data en la base.

Nada de esto toca `app.js`, `dashboard.js` ni los componentes — el patrón ya
está armado para que agregar un módulo sea solo declarar su config.

## Qué falta si se sigue con esta fase

- **Pantallas de Usuarios y Auditoría en el frontend**: los endpoints ya
  existen y están protegidos (`/api/usuarios`, `/api/auditoria`); falta la
  página HTML que los consuma (tabla de usuarios con selector de rol, tabla
  de actividad con filtros). Es el mismo patrón de `pages/ventas.html` pero
  sin esquema de dashboard (solo tabla).
- **Panel de administración**: vista que resuma todos los módulos conectados
  (conteos, últimos registros, estado de conexión) en un solo lugar.
- **Compras, RRHH, Producción, Marketing**: siguen sin existir ni en modo
  local ni en base de datos (están `enabled: false` en `company.json`).
  Finanzas está habilitado pero sigue en modo local (CSV/localStorage).
- **Importar desde Excel (.xlsx) o Google Sheets**: no está implementado —
  hoy solo CSV. Excel requeriría una librería de parseo adicional (ej. SheetJS)
  en el backend; Google Sheets requeriría OAuth con Google.
- **Revocar permisos al instante**: hoy los permisos viajan dentro del JWT y
  se recalculan recién en el próximo login (ver la nota en
  `src/middleware/permisos.js`). Si algún cliente necesita que un cambio de
  rol aplique de inmediato, hay que mover la verificación a una consulta por
  request o mantener una lista de tokens invalidados.
