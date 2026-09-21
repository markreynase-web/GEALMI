-- Fase A: multi-tenencia. Cada empresa es un tenant; toda fila de negocio
-- (ventas/inventario/clientes/finanzas/audit_log) queda marcada con
-- empresa_id. roles/permisos/rol_permiso se QUEDAN globales a propósito
-- (mismo catálogo de roles para todas las empresas -- roles por empresa
-- queda fuera de alcance de esta fase).
--
-- La identidad de usuario sigue siendo global (usuarios.email UNIQUE, sin
-- cambios) -- lo que cambia es que la membresía a una empresa (y el rol
-- dentro de ella) vive en la tabla puente usuario_empresa, para soportar
-- que una misma persona administre más de una empresa con roles distintos
-- en cada una (requisito del "login inteligente").

CREATE TABLE IF NOT EXISTS empresas (
  id             SERIAL PRIMARY KEY,
  nombre         VARCHAR(200) NOT NULL,
  logo           VARCHAR(20),
  activo         BOOLEAN NOT NULL DEFAULT true,
  creado_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catálogo de módulos posibles (reemplaza la lista estática que vivía en
-- config/company.json). "id" es el mismo string que ya usa el frontend
-- (NAMESPACE / data-modulo), no un SERIAL nuevo.
CREATE TABLE IF NOT EXISTS modulos (
  id            VARCHAR(40) PRIMARY KEY,
  label         VARCHAR(80) NOT NULL,
  icon          VARCHAR(10),
  page          VARCHAR(80) NOT NULL,
  base_de_datos BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO modulos (id, label, icon, page, base_de_datos) VALUES
  ('ventas',     'Ventas',     '💰', 'ventas.html',     true),
  ('inventario', 'Inventario', '📦', 'inventario.html', true),
  ('clientes',   'Clientes',   '🤝', 'clientes.html',   true),
  ('finanzas',   'Finanzas',   '💵', 'finanzas.html',   true),
  ('compras',    'Compras',    '🛒', 'compras.html',    false),
  ('rrhh',       'RRHH',       '👥', 'rrhh.html',       false),
  ('produccion', 'Producción', '🏭', 'produccion.html', false),
  ('marketing',  'Marketing',  '📣', 'marketing.html',  false)
ON CONFLICT (id) DO NOTHING;

-- Qué módulos tiene habilitados cada empresa. Presencia de la fila =
-- habilitado (mismo patrón sin columna "enabled" que ya usa rol_permiso).
CREATE TABLE IF NOT EXISTS empresa_modulos (
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  modulo_id  VARCHAR(40) NOT NULL REFERENCES modulos(id) ON DELETE CASCADE,
  PRIMARY KEY (empresa_id, modulo_id)
);

-- Membresía de un usuario a una empresa, con el rol que tiene EN esa
-- empresa (puede ser distinto de una empresa a otra). "activo" aquí es
-- "activo en esta empresa" -- separado de usuarios.activo, que es el
-- apagado global de la cuenta (poco usado, pensado para offboarding total
-- de la plataforma, no para "sácalo de mi empresa").
CREATE TABLE IF NOT EXISTS usuario_empresa (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  rol_id     INTEGER NOT NULL REFERENCES roles(id),
  activo     BOOLEAN NOT NULL DEFAULT true,
  creado_el  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, empresa_id)
);

-- --- Backfill: una empresa semilla para todo lo que ya existe hoy. ---
-- Estos INSERT están escritos para ser seguros también sobre una base de
-- datos nueva/vacía (no solo para migrar datos existentes): el primero se
-- guarda solo si no hay ninguna empresa todavía, y el resto siempre elige
-- "la primera empresa que exista" en vez de asumir un id fijo.
INSERT INTO empresas (nombre, logo)
SELECT 'Mi proyecto de datos', 'PD'
WHERE NOT EXISTS (SELECT 1 FROM empresas);

-- Los módulos que config/company.json ya tenía "enabled": true.
--
-- SOLO LA PRIMERA VEZ: cuando todavía ninguna empresa tiene módulos (la tabla acaba de crearse
-- arriba). migrate.js vuelve a correr TODOS los .sql en cada ejecución; sin este filtro, cada
-- "npm run migrate" volvía a encender estos módulos en la empresa semilla aunque el super admin
-- los hubiera apagado a propósito desde su panel.
INSERT INTO empresa_modulos (empresa_id, modulo_id)
SELECT (SELECT id FROM empresas ORDER BY id LIMIT 1), m.id
FROM modulos m
WHERE m.id IN ('ventas', 'inventario', 'clientes', 'finanzas', 'rrhh')
  AND NOT EXISTS (SELECT 1 FROM empresa_modulos)
ON CONFLICT DO NOTHING;

-- Cada usuario existente queda de miembro de la empresa semilla, con el
-- rol que ya tenía en usuarios.rol_id (Fase 4).
--
-- SOLO LA PRIMERA VEZ: cuando todavía no existe NINGUNA membresía en toda la base (la tabla
-- acaba de crearse arriba). migrate.js vuelve a correr TODOS los .sql en cada ejecución, así que
-- este relleno se ejecuta para siempre y cualquier filtro más laxo mete gente de nuevo en la
-- empresa semilla con cada "npm run migrate":
--   * sin filtro: TODOS los usuarios, también los de otras empresas (fuga entre empresas);
--   * con "no pertenece a ninguna empresa" (primer arreglo): las cuentas que quedan sin empresa
--     -- alguien a quien un administrador quitó de su empresa (DELETE /api/usuarios/:id solo
--     borra la membresía) o los usuarios de una empresa que el super admin eliminó -- recuperaban
--     el acceso a la semilla con su rol antiguo.
-- El super admin no necesita membresía: su login no pasa por usuario_empresa.
INSERT INTO usuario_empresa (usuario_id, empresa_id, rol_id)
SELECT u.id, (SELECT id FROM empresas ORDER BY id LIMIT 1), u.rol_id
FROM usuarios u
WHERE NOT EXISTS (SELECT 1 FROM usuario_empresa)
ON CONFLICT (usuario_id, empresa_id) DO NOTHING;

-- --- Columnas empresa_id en las tablas de negocio. ---
ALTER TABLE ventas       ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE inventario   ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE clientes     ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE finanzas     ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE audit_log    ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);

UPDATE ventas     SET empresa_id = (SELECT id FROM empresas ORDER BY id LIMIT 1) WHERE empresa_id IS NULL;
UPDATE inventario SET empresa_id = (SELECT id FROM empresas ORDER BY id LIMIT 1) WHERE empresa_id IS NULL;
UPDATE clientes   SET empresa_id = (SELECT id FROM empresas ORDER BY id LIMIT 1) WHERE empresa_id IS NULL;
UPDATE finanzas   SET empresa_id = (SELECT id FROM empresas ORDER BY id LIMIT 1) WHERE empresa_id IS NULL;
UPDATE audit_log  SET empresa_id = (SELECT id FROM empresas ORDER BY id LIMIT 1) WHERE empresa_id IS NULL;

ALTER TABLE ventas       ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE inventario   ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE clientes     ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE finanzas     ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE audit_log    ALTER COLUMN empresa_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_empresa     ON ventas (empresa_id);
CREATE INDEX IF NOT EXISTS idx_inventario_empresa ON inventario (empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa   ON clientes (empresa_id);
CREATE INDEX IF NOT EXISTS idx_finanzas_empresa   ON finanzas (empresa_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_empresa  ON audit_log (empresa_id);

-- Mismo candado que 007/008: deny-by-default para los roles anon/authenticated
-- de PostgREST de Supabase. El backend se conecta con un rol BYPASSRLS y no
-- se ve afectado -- esto NO es aislamiento por tenant, el aislamiento real
-- vive en los WHERE empresa_id=... de Express (ver crudFactory.js y cada
-- ruta manual). Ver backend/README.md / notas de Fase A para el detalle.
ALTER TABLE empresas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresas         FORCE  ROW LEVEL SECURITY;
ALTER TABLE modulos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE modulos          FORCE  ROW LEVEL SECURITY;
ALTER TABLE empresa_modulos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_modulos  FORCE  ROW LEVEL SECURITY;
ALTER TABLE usuario_empresa  ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_empresa  FORCE  ROW LEVEL SECURITY;
