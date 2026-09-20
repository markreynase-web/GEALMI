-- Paso 6 del backlog: notificaciones en base de datos + mensajes entre
-- usuarios, UN solo sistema. Antes la campana (components/topbar.js) armaba
-- todo al vuelo bajándose el inventario entero en cada página: no había
-- "leída", ni destinatario, ni forma de que un usuario le avisara a otro.
--
-- Una fila por DESTINATARIO (un mensaje a "todos" son N filas): así "sin
-- leer", "enterado" y "entregado" son un simple campo de esa fila y el conteo
-- de la campana es un COUNT sobre un índice, sin JOINs. Los envíos manuales
-- comparten `lote` para que quien los mandó vea cuántos lo recibieron, lo
-- leyeron y dieron "Enterado".
CREATE TABLE IF NOT EXISTS notificaciones (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  -- Destinatario. CASCADE: sin la persona no hay a quién avisarle.
  usuario_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  -- mensaje | stock_bajo | arqueo_diferencia | caja_abierta | vencimientos
  tipo             VARCHAR(30) NOT NULL,
  -- 'alta' = importante: se muestra como aviso fijo hasta que el usuario da
  -- "Enterado" (leerla no alcanza).
  prioridad        VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('normal', 'alta')),
  titulo           VARCHAR(150) NOT NULL,
  cuerpo           TEXT,
  -- Solo el nombre de una página interna ("cajas", "inventario"): la API
  -- rechaza cualquier otra cosa para que el enlace no pueda apuntar afuera.
  enlace           VARCHAR(60),
  -- Quién la mandó; NULL = la generó el sistema. SET NULL (y el nombre
  -- congelado al lado) para que el historial no cambie si esa cuenta se
  -- borra -- mismo criterio que audit_log.
  remitente_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  remitente_nombre VARCHAR(100),
  lote             UUID,
  -- Identifica un "episodio" para no avisar dos veces lo mismo (p. ej.
  -- 'stock_bajo:15:2026-09-20'). NULL en los mensajes manuales.
  clave            VARCHAR(160),
  creada_el        TIMESTAMPTZ NOT NULL DEFAULT now(),
  entregada_el     TIMESTAMPTZ,
  leida_el         TIMESTAMPTZ,
  enterado_el      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_fecha ON notificaciones (usuario_id, creada_el DESC);
CREATE INDEX IF NOT EXISTS idx_notificaciones_sin_leer      ON notificaciones (usuario_id) WHERE leida_el IS NULL;
CREATE INDEX IF NOT EXISTS idx_notificaciones_sin_entregar  ON notificaciones (usuario_id) WHERE entregada_el IS NULL;
CREATE INDEX IF NOT EXISTS idx_notificaciones_por_enterar   ON notificaciones (usuario_id) WHERE prioridad = 'alta' AND enterado_el IS NULL;
CREATE INDEX IF NOT EXISTS idx_notificaciones_lote          ON notificaciones (lote) WHERE lote IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notificaciones_empresa_fecha ON notificaciones (empresa_id, creada_el);
-- La garantía real contra avisos repetidos (src/notificaciones.js inserta con
-- ON CONFLICT DO NOTHING sobre este índice), aunque dos peticiones lleguen a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_clave_unica ON notificaciones (usuario_id, clave) WHERE clave IS NOT NULL;

ALTER TABLE notificaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE notificaciones FORCE ROW LEVEL SECURITY;

-- Recibir y leer las propias notificaciones no pide permiso (como Seguridad).
-- Mandar mensajes a otros sí: ver todos los destinatarios, mandar y consultar
-- el estado de lo enviado. Mismo patrón que 040 (cajas) y 042 (api_keys).
INSERT INTO permisos (nombre) VALUES ('mensajes.enviar')
ON CONFLICT (nombre) DO NOTHING;

DO $$
DECLARE
  r_admin      INTEGER := (SELECT id FROM roles WHERE nombre = 'administrador');
  r_gerente    INTEGER := (SELECT id FROM roles WHERE nombre = 'gerente');
  r_supervisor INTEGER := (SELECT id FROM roles WHERE nombre = 'supervisor');
BEGIN
  -- Administrador, gerente y supervisor: quienes de verdad le piden cosas al
  -- equipo ("revisa tu caja"). Ventas/inventario/consulta solo reciben.
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r, p.id
  FROM (VALUES (r_admin), (r_gerente), (r_supervisor)) AS roles_con_permiso(r)
  CROSS JOIN permisos p
  WHERE r IS NOT NULL AND p.nombre = 'mensajes.enviar'
  ON CONFLICT DO NOTHING;
END $$;
