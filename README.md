# GEALMI

Reorganización del proyecto original (un solo `index.html` de 822 líneas) en módulos,
más el fix de un problema de seguridad encontrado en el análisis inicial.

## Cómo correrlo

Necesita servidor local (usa ES modules — `import`/`export` — que los navegadores
bloquean sobre `file://`):

```bash
cd GEALMI
python -m http.server 8000
# o: npx serve
```

Abre `http://localhost:8000/` (redirige a `pages/ventas.html`).

## Qué se hizo en esta iteración

**Fase 1 — Modularización**
El JS de 400+ líneas que vivía todo en un `<script>` ahora está dividido en:

| Archivo | Responsabilidad |
|---|---|
| `js/utils.js` | Formateo de números, parsing flexible de fechas/números, `escapeHtml` |
| `js/parsing.js` | Lectura de CSV/ZIP, detección automática de columnas |
| `js/storage.js` | Persistencia en `localStorage`, con namespace por página |
| `js/filters.js` | Rango de fechas y filtrado por periodo |
| `js/charts.js` | Construcción de gráficos Chart.js |
| `js/dashboard.js` | Render principal del DOM (KPIs, gráfico, rankings, tabla debug) |
| `js/app.js` | Estado de la app, manejo de archivos, wiring de botones, arranque |

El CSS de un solo `<style>` gigante pasó a `css/base.css`, `css/cards.css`, `css/tables.css`.

**Fix de seguridad (XSS)**
Los nombres de columna y valores de celda del CSV del usuario se insertaban con
`innerHTML` sin escapar en varios lugares (rankings, categorías, tabla de columnas
detectadas). Un CSV con algo como `<img src=x onerror=...>` en una celda se habría
ejecutado. Ahora todo pasa por `escapeHtml()` (en `js/utils.js`) antes de insertarse.
Los `textContent` que ya eran seguros se dejaron igual (no hacía falta tocarlos).

**Fase 2 — Preparado para cualquier empresa**
`config/company.json` es ahora la única fuente de verdad sobre qué ve cada
cliente. Contiene el nombre de la empresa, el logo (texto corto) y la lista
completa de 8 módulos posibles (Ventas, Inventario, Compras, Clientes, RRHH,
Finanzas, Producción, Marketing), cada uno con `enabled: true/false`.

- **Sistema de módulos**: cada módulo es su propia página física en `pages/`
  (`ventas.html`, `inventario.html`, `compras.html`, `clientes.html`,
  `rrhh.html`, `finanzas.html`, `produccion.html`, `marketing.html`). Todas
  comparten el mismo `js/app.js` / `js/dashboard.js` / etc. — no hay lógica
  duplicada. Cada página se identifica con `<body data-modulo="...">`, y
  `app.js` lee ese atributo para saber su propio namespace de `localStorage`
  (así los datos de Inventario nunca se mezclan con los de Ventas) y para
  buscar su propia entrada en `config/company.json`.
- **Menú dinámico** (`components/nav.js`): lee `config/company.json` y solo
  pinta enlaces a los módulos con `enabled: true`. Si un cliente no tiene
  Inventario habilitado, el link a Inventario ni siquiera se agrega al DOM
  (no es un `display:none`, no existe). Si un cliente solo tiene un módulo
  habilitado, el menú no se muestra.
- **Branding por configuración** (`aplicarBranding()` en `js/app.js`): el
  nombre de la empresa, el logo (iniciales) y el título de la pestaña salen
  de `config/company.json`. Si el usuario ya guardó un `bizName` distinto en
  `localStorage` (lo escribió a mano alguna vez), ese valor local tiene
  prioridad sobre el de config, igual que antes.
- **Alcance actual (Nivel 1)**: el config controla qué módulos existen y el
  branding. El *contenido* de cada dashboard (qué columna es KPI, cuál es
  fecha, etc.) lo sigue decidiendo la detección automática de `parsing.js`
  a partir del CSV que suba cada cliente — todavía no hay forma de fijar
  "la columna X siempre va en el KPI 1" desde config. Eso quedaría para una
  iteración posterior si se necesita.
- `index.html` ahora redirige al primer módulo con `enabled: true` en vez de
  ir siempre a `ventas.html` a la fuerza.

**Fase 3 — Captura de datos**
Ya no vive todo en el navegador: **Ventas, Inventario y Clientes** están
conectados a un backend real (Node.js + Express + PostgreSQL).

Roadmap de esta fase:
- ✅ **CRUD de Ventas completo** — crear, editar y borrar desde la interfaz
  (antes solo se podía crear e importar CSV).
- ✅ **CRUD reutilizable** — `backend/src/crudFactory.js` genera las 5 rutas
  (GET/POST/PUT/DELETE/import) para cualquier tabla a partir de su config de
  columnas; ya no se escribe cada ruta a mano por módulo. Del lado del
  frontend, `js/esquemas.js` cumple el mismo rol: declara los campos del
  formulario, las columnas de la tabla y el mapeo hacia el dashboard genérico.
- ✅ **Inventario migrado** — formulario "Nuevo producto" (nombre, categoría,
  stock, stock mínimo, precio unitario) + tabla editable + import CSV,
  guardando en `tabla inventario`.
- ✅ **Clientes migrado** — formulario "Nuevo cliente" (nombre, email,
  teléfono, dirección, compras totales) + tabla editable + import CSV,
  guardando en `tabla clientes`.
- ✅ **Sistema de componentes reutilizables**: `components/formularioRegistro.js`
  (arma cualquier formulario a partir de un esquema) y
  `components/tablaRegistros.js` (tabla con editar inline y borrar, también
  genérica). Ningún módulo tiene su HTML de formulario escrito a mano.
- ⏳ **Panel de administración**: pendiente, es el siguiente paso.

Cómo migrar un módulo nuevo a base de datos con este patrón: 1 migración SQL
+ 4 líneas en `backend/src/routes/<modulo>.js` usando `crearRouterCRUD()` +
una entrada en `js/esquemas.js` + `"baseDeDatos": true` en `company.json`.
Ver `backend/README.md` para el detalle técnico completo.



**Fase 4 — Login, roles y permisos (en progreso)**

Paso 1 de 5, hecho:
- ✅ **Login con JWT**: tabla `usuarios` (con `password_hash` vía bcrypt y una
  columna `rol`, lista para el paso 2 pero sin lógica todavía), endpoint
  `POST /api/auth/login`, y `GET /api/auth/me` protegida por el primer
  middleware (`auth()`, ver `backend/src/middleware/auth.js`) — es la primera
  pieza del pipeline `auth() → verificarPermiso() → CRUD` que armaste.
- ✅ **`pages/login.html`**: pantalla de login real, guarda el token en el
  navegador (`js/sesion.js`) y redirige al dashboard.
- ✅ **Widget de sesión** en el header de las 8 páginas de módulos: muestra
  quién está logueado (o el link para entrar) y el botón de cerrar sesión.
- No hay pantalla de "crear cuenta": el primer admin se crea desde la
  terminal con `npm run seed:admin` (ver `backend/README.md`).
- **Importante:** por ahora el login es solo informativo — ninguna ruta de
  Ventas/Inventario/Clientes está protegida todavía, y las páginas no
  redirigen a login si no hay sesión. Eso es intencional: llega con el paso 4
  (Middleware), cuando `verificarPermiso()` ya sepa qué puede hacer cada rol.

Siguiente: Roles → Permisos → Middleware (conectar todo esto al CRUD
existente) → Auditoría → Panel de administración.

*(Nota: esta lista de pasos quedó desactualizada por Roles/Permisos/
Auditoría — ver `backend/src/middleware/permisos.js`, las migraciones
005/006/009 y la sección de Fase A abajo, todas ya implementadas.)*

**Fase A — Plataforma multi-tenant (SaaS)**

GEALMI deja de ser "un despliegue = una empresa" y pasa a ser un solo
backend que sirve a muchas empresas, aisladas por fila (`empresa_id`), no por
despliegue. Motivación completa en el historial del proyecto; resumen técnico:

- ✅ **`empresa_id` en cada tabla de negocio** (`ventas`, `inventario`,
  `clientes`, `finanzas`, `audit_log`) — ver `backend/migrations/012_empresas.sql`.
  `roles`/`permisos`/`rol_permiso` se quedan globales a propósito (mismo
  catálogo para todas las empresas, por ahora).
- ✅ **Identidad global + membresía por empresa**: `usuarios.email` sigue
  siendo único globalmente; la tabla puente `usuario_empresa` guarda a qué
  empresa(s) pertenece cada usuario y con qué rol en cada una (una persona
  puede ser administrador en una empresa y gerente en otra).
- ✅ **Login inteligente en dos pasos**: `POST /api/auth/login` resuelve la
  empresa sola si el usuario pertenece a una sola; si pertenece a varias,
  devuelve un `preAuthToken` de 5 minutos + la lista, y
  `POST /api/auth/login/empresa` completa el login tras elegir una
  (revalidado server-side, nunca se confía en el `empresa_id` que manda el
  cliente).
- ✅ **`crudFactory.js` scoped por empresa**: un solo cambio ahí cubre
  `clientes.js` completo e `inventario.js` (GET/PUT/import); `ventas.js`,
  `inventario.js` (POST/DELETE), `finanzas.js`, `usuarios.js` y
  `auditoria.js` se editaron a mano por ser rutas manuales (no pasan por el
  factory). `PUT`/`DELETE` cruzando de empresa devuelven 404 (no 403), para
  no confirmar que el id existe en otro lado.
- ✅ **`GET /api/empresa/actual`** reemplaza a `config/company.json` (ya
  borrado del repo): branding + módulos habilitados salen de la base de
  datos, scoped a la empresa activa del token.
- ✅ **`js/apiConfig.js`**: la URL del backend pasa de "por empresa" (vivía
  en `company.json`) a una constante fija — ya era en la práctica un solo
  backend para todos los clientes.
- **Trade-off aceptado:** el JWT (8h) congela la empresa activa igual que ya
  congelaba los permisos — alguien removido de una empresa a media sesión
  sigue teniendo acceso hasta por 8h o hasta volver a loguearse.

**Fase B — Landing page pública**

`index.html` deja de ser un redirect ciego a `pages/inicio.html` y pasa a
ser una landing real (qué es GEALMI, el núcleo, módulos por industria,
IA como roadmap, planes, contacto) — el login inteligente de Fase A ya era
la pieza que le faltaba para tener sentido como fachada pública. Quien ya
tiene sesión sigue yendo directo a su dashboard, sin ver la landing.

**Fase C — Vertical automotriz (Vehículos, Repuestos, Postventa)**

Primer vertical de industria sobre el núcleo multi-tenant, a partir de la
conversación con el gerente de la concesionaria. Alcance de esta pasada:
Vehículos, Repuestos y Postventa (órdenes de servicio) con mano de obra
separada del costo de repuestos — facturación electrónica/SUNAT queda para
una fase aparte (es su propio proyecto de cumplimiento legal, no algo para
meter de pasada).

- ✅ **`vehiculos`**: autos de un CLIENTE (para dar seguimiento en
  postventa) — no es el inventario de venta propio de la concesionaria, eso
  seguiría usando el módulo genérico Inventario si algún día hace falta.
- ✅ **`repuestos`**: catálogo especializado (código OEM, compatibilidad,
  ubicación, proveedor, tiempo de reposición) — tabla propia, hermana de
  Inventario, no la misma tabla, para no ensuciar el módulo genérico con
  columnas específicas de autopartes.
- ✅ **`postventa`** (órdenes de servicio): un repuesto "principal" opcional
  (mismo patrón que `ventas.producto_id`: descuenta stock con `FOR UPDATE`),
  `costo_repuestos` siempre editable a mano para cubrir órdenes con más de
  un repuesto (no hay carrito de líneas múltiples — construirlo sería una
  inversión de plataforma nueva, no algo específico de este módulo), y
  `mano_obra` + `total` (calculado en el servidor, nunca confiado del
  cliente). No genera un ingreso automático en Finanzas todavía: cuándo una
  orden "cuenta como ingreso real" según su `estado` es una decisión de
  negocio que queda fuera de esta fase.
- ✅ **Módulos opt-in por empresa**: `vehiculos`/`repuestos`/`postventa` se
  agregan al catálogo (`modulos`) pero no se habilitan para ninguna empresa
  existente — cada una se activa a mano en `empresa_modulos` cuando
  corresponda (ver comentario en `backend/migrations/014_vertical_automotriz.sql`).
- ✅ **Arreglo de paso, en `crudFactory.js`**: el PUT genérico borraba en
  silencio cualquier columna que no viniera en el body de una edición
  inline (afectaba ya a `clientes.direccion`/`notas` sin que nadie lo
  notara) — Repuestos tiene 5 campos así, así que este bug se volvió
  imposible de ignorar y se arregló antes de construir el módulo nuevo.
- ✅ **`esquemaConOpcionesFrescas()` (`js/app.js`) generalizado**: antes solo
  corría para Ventas con 2 campos escritos a mano; ahora lee `campo.fuente`
  de cualquier esquema (ya existía como marcador sin usar) para poblar
  selects de cualquier módulo con datos frescos de otro — así
  `vehiculos.cliente_id`, `postventa.cliente_id/vehiculo_id/repuesto_id`,
  etc. funcionan todos con el mismo mecanismo, sin código nuevo por módulo.

**Panel de super administrador**

Hueco encontrado durante Fase C: no había ningún rol por encima de
"administrador de una empresa" — dar de alta una empresa nueva, habilitarle
módulos, o crear su primer usuario administrador era 100% SQL manual. Se
agregó un **super admin**: `usuarios.es_super_admin`, una bandera global
separada del sistema de roles por empresa (`usuario_empresa`) a propósito
(ese sistema está armado alrededor de "una empresa a la vez"; un super
admin necesita lo contrario). Su login es exclusivo: si la cuenta es super
admin, el token nunca lleva `empresa_id`/`permisos` y nunca pasa por el
selector de empresas, aunque también tenga membresías normales (v1, sin
selector de modo). Panel en `pages/superadmin.html` (standalone, no usa
`app.js`/sidebar de módulos): crear empresas, habilitar/deshabilitar sus
módulos, y agregar su primer administrador — mismo flujo que antes hacía
`seedAdmin.js` por terminal, ahora desde una pantalla real. El primer super
admin sigue creándose por terminal (`npm run seed:superadmin`, huevo-y-gallina:
para crear uno desde la API hace falta ya serlo).

**GEALMI AI (Fase D)**

Última fase del roadmap post-reunión con la concesionaria: IA real, no solo
anunciada en el landing. Un solo agente de Claude con tool use resuelve a la
vez la capa estadística (predicción de ventas, alertas de stock, productos
de baja rotación, detección de anomalías, recomendación de compras) y la
capa de lenguaje natural — no son dos sistemas separados: el backend expone
un set de "herramientas de datos" (consultas SQL parametrizadas, scoped a
`empresa_id`, ver `backend/src/khipuAiTools.js`), Claude decide cuáles
necesita para responder, y arma la respuesta final en español. El set de
herramientas se ajusta según qué módulos tiene habilitados cada empresa.

Se accede vía un **widget flotante** (🤖, esquina inferior derecha)
disponible en toda la app una vez habilitada, no una página de módulo
aparte — decisión explícita para que esté a mano desde cualquier pantalla.
Modelo **Claude Sonnet 5** (mejor relación costo/calidad para preguntas
cortas con tool use, frente a Opus) y **generación en vivo** (cada pregunta
es una llamada real, sin cachear la respuesta, priorizando frescura sobre
costo) — con un límite de 40 preguntas/día por usuario como techo barato de
abuso. Opt-in por empresa,
igual que Vehículos/Repuestos/Postventa (`backend/migrations/016_khipu_ai.sql`),
habilitable desde el panel de super administrador sin código nuevo (es una
fila más del catálogo `modulos` que ese panel ya gestiona).

## Qué falta (fases siguientes, aún no implementadas)

- **Personalización visual por empresa**: se resolvió más simple que el plan
  original de `css/themes/` (que llegó a existir vacía como andamiaje y ya se
  eliminó del repo) — una sola columna `color_primario` por empresa
  (`backend/migrations/018_empresa_tema.sql`, a propósito UN color y no un
  sistema de temas completo), aplicada en runtime como variable CSS desde
  `js/config.js`.
- **Componentes reutilizables**: ya existen varios en `components/`
  (`sidebar.js`, `panelLateral.js`, `topbar.js`, `footer.js`,
  `tablaRegistros.js`, `formularioRegistro.js`, `khipuAiWidget.js`) —
  `nav.js` fue el primero y desde entonces fue reemplazado por `sidebar.js`.
  Lo que sigue pendiente: `dashboard.js` todavía escribe el HTML de
  KPIs/gráficos directamente en vez de usar piezas reutilizables tipo
  `KpiCard`.

*(Nota: el "Nivel 2 de config" y el punto sobre `assets/` vacía que estaban
aquí antes dependían de `config/company.json`, que ya no existe — ver
"Fase A" más abajo. `assets/` ya tiene `login-hero.png` y `logo-icon.png`.)*

## Estructura

```
Khipu1/
  index.html             → redirige a pages/inicio.html (o a login.html si no hay sesión)
  css/
    base.css             → variables de tema, reset, header, hero, module-nav
    cards.css            → KPIs, paneles, gráficos
    forms.css            → formularios, tabla editable
    layout.css           → estructura general de página
    panel-lateral.css    → panel lateral deslizable
    tables.css           → tabla de debug, badges de rol
    khipu-ai-widget.css  → widget flotante de GEALMI AI
  js/
    app.js, apiConfig.js, api.js, config.js, dashboard.js, charts.js,
    filters.js, parsing.js, storage.js, utils.js, esquemas.js, sesion.js,
    modoBackend.js, khipuAi.js
                          → estado, render, fetch al backend, parsing de
                            CSV/ZIP, y el cliente del widget de GEALMI AI
  components/
    sidebar.js            → menú dinámico de módulos (reemplaza al viejo nav.js)
    panelLateral.js        → abre/cierra el panel lateral deslizable
    topbar.js, footer.js   → cabecera y pie compartidos
    tablaRegistros.js      → tabla editable reutilizable
    formularioRegistro.js  → formulario reutilizable
    khipuAiWidget.js       → UI del widget flotante de GEALMI AI
  pages/
    inicio.html, login.html, ventas.html, inventario.html, compras.html,
    clientes.html, rrhh.html, finanzas.html, produccion.html, marketing.html,
    postventa.html, repuestos.html, vehiculos.html, auditoria.html,
    usuarios.html, superadmin.html, privacidad.html
                          → una página física por módulo, mismo motor JS/CSS,
                            cada una con <body data-modulo="..."> propio
  lib/
    chart.js, papaparse.min.js, jszip.min.js  → librerías de terceros sin cambios
  assets/
    login-hero.png, logo-icon.png
  backend/
    src/
      server.js            → arma la app Express y monta todas las rutas
      db.js                 → pool de conexión
      crudFactory.js        → genera CRUD estándar por módulo
      registroAuditoria.js  → helper para registrar auditoría (usado por crudFactory y varias rutas manuales)
      khipuAiTools.js       → herramientas de datos que usa GEALMI AI (tool use)
      middleware/           → auth.js, permisos.js
      routes/                → una ruta por módulo (auth, clientes, ventas, ...)
    migrations/              → historial de esquema SQL, no se edita retroactivamente
```

### Cómo dar de alta/baja un módulo a un cliente
Desde Fase A esto ya no se edita en un archivo: se hace en la base de datos,
en la tabla puente `empresa_modulos` (una fila = un módulo habilitado para
esa empresa; ver `backend/migrations/012_empresas.sql`). El menú (sidebar) y
el dashboard de inicio se ajustan solos, sin tocar código.
