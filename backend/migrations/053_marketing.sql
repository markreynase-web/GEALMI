-- Paso 9 del backlog: Marketing v1. La cadena que se mide es
--   Campaña -> Clientes objetivo -> Venta -> Resultado
-- sin plataforma de envío masivo: GEALMI arma la lista de a quién contactar,
-- lleva el estado de cada contacto (objetivo, contactado, respondió, convirtió)
-- y suma las ventas que se atribuyen a la campaña. El contacto en sí (WhatsApp,
-- llamada, correo) lo hace la persona, por su cuenta.
--
-- Idempotente a propósito: migrate.js vuelve a correr TODOS los .sql cada vez.

CREATE TABLE IF NOT EXISTS campanas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre         VARCHAR(150) NOT NULL,
  descripcion    TEXT,
  canal          VARCHAR(20) NOT NULL DEFAULT 'whatsapp' CHECK (canal IN ('whatsapp', 'correo', 'redes', 'presencial', 'llamada', 'otro')),
  estado         VARCHAR(12) NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'activa', 'pausada', 'finalizada')),
  fecha_inicio   DATE,
  fecha_fin      DATE,
  presupuesto    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (presupuesto >= 0),
  -- Texto sugerido para contactar a los clientes (por WhatsApp, correo...).
  mensaje        TEXT,
  -- Con qué criterios se armó la lista objetivo la última vez (solo referencia).
  segmento       JSONB,
  creada_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fecha_fin IS NULL OR fecha_inicio IS NULL OR fecha_fin >= fecha_inicio)
);
CREATE INDEX IF NOT EXISTS idx_campanas_empresa_estado ON campanas (empresa_id, estado);

-- Un cliente en la lista de una campaña, con su avance. Los estados son un
-- embudo: 'contactado' cuenta como contactado, 'respondio' como contactado y
-- respondió, y 'convirtio' como los tres (ver routes/marketing.js).
CREATE TABLE IF NOT EXISTS campana_clientes (
  campana_id    INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  -- Redundante con campana_id, pero deja filtrar por empresa sin un JOIN.
  empresa_id    INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  estado        VARCHAR(12) NOT NULL DEFAULT 'objetivo' CHECK (estado IN ('objetivo', 'contactado', 'respondio', 'convirtio', 'descartado')),
  etiqueta      VARCHAR(40),
  notas         VARCHAR(250),
  contactado_el TIMESTAMPTZ,
  respondio_el  TIMESTAMPTZ,
  convirtio_el  TIMESTAMPTZ,
  agregado_el   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campana_id, cliente_id)
);
CREATE INDEX IF NOT EXISTS idx_campana_clientes_cliente ON campana_clientes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_campana_clientes_empresa ON campana_clientes (empresa_id);

-- Atribución: cada venta puede pertenecer a UNA campaña (se elige al registrar
-- la venta). SET NULL: si se borra la campaña, las ventas se conservan.
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS campana_id INTEGER REFERENCES campanas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_campana ON ventas (campana_id) WHERE campana_id IS NOT NULL;

ALTER TABLE campanas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanas         FORCE ROW LEVEL SECURITY;
ALTER TABLE campana_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE campana_clientes FORCE ROW LEVEL SECURITY;

-- Marketing pasa de "módulo libre (CSV)" a módulo con base de datos y permisos
-- propios, igual que se hizo con compras, RRHH y producción en 022.
UPDATE modulos SET base_de_datos = true WHERE id = 'marketing';

INSERT INTO permisos (nombre)
SELECT 'marketing.' || accion FROM (VALUES ('ver'), ('crear'), ('editar'), ('eliminar')) AS a(accion)
ON CONFLICT (nombre) DO NOTHING;

DO $$
DECLARE
  r_admin      INTEGER := (SELECT id FROM roles WHERE nombre = 'administrador');
  r_gerente    INTEGER := (SELECT id FROM roles WHERE nombre = 'gerente');
  r_supervisor INTEGER := (SELECT id FROM roles WHERE nombre = 'supervisor');
BEGIN
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_admin, id FROM permisos WHERE r_admin IS NOT NULL AND nombre LIKE 'marketing.%'
  ON CONFLICT DO NOTHING;

  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_gerente, id FROM permisos
  WHERE r_gerente IS NOT NULL AND nombre IN ('marketing.ver', 'marketing.crear', 'marketing.editar')
  ON CONFLICT DO NOTHING;

  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_supervisor, id FROM permisos
  WHERE r_supervisor IS NOT NULL AND nombre = 'marketing.ver'
  ON CONFLICT DO NOTHING;
END $$;
