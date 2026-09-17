-- Sub-fase E (roadmap competitivo, Nivel 2): módulo de Cajas/Turno.
--
-- SUPUESTO EXPLÍCITO DEL ARQUEO (documentado a pedido, no implementado en
-- silencio): el sistema genérico de ventas/finanzas de GEALMI HOY NO
-- distingue medio de pago -- no hay columna medio_pago en ventas ni en
-- finanzas. Lo único parecido en todo el proyecto es pagos_membresia del
-- vertical Gimnasio (migración 027), una tabla completamente aparte que no
-- toca ventas/finanzas. Por eso el arqueo de src/routes/cajas.js asume que
-- TODO lo registrado en finanzas durante un turno es efectivo -- si el
-- negocio ya cobra con Yape/tarjeta/transferencia, la "diferencia" que
-- calcula no es necesariamente un faltante real de caja. Agregar medio_pago
-- real a ventas.js queda anotado como una sub-fase futura, no de esta.

-- cajas.empresa_id: oversight de la migración 036 (turnos_caja sí lo tiene,
-- cajas no) -- mismo criterio de denormalización que el resto del proyecto:
-- empresa_id directo en cada tabla, para no depender de un JOIN a
-- sucursales solo para poder filtrar por empresa. La tabla está vacía
-- todavía (nada insertó en ella hasta esta sub-fase), así que el backfill
-- de abajo es solo por las dudas / por si se re-corre esta migración.
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE cajas c SET empresa_id = s.empresa_id FROM sucursales s WHERE s.id = c.sucursal_id AND c.empresa_id IS NULL;
ALTER TABLE cajas ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cajas_empresa ON cajas (empresa_id);

-- Segundo hallazgo, mismo espíritu que el anterior: DELETE /superadmin/
-- empresas/:id (migración 031) hace un borrado real y cascadeado de una
-- empresa -- ese cascade depende de que CADA fila que referencia algo de
-- esa empresa también se borre o quede huérfana de forma segura. Ninguna de
-- las FK que trajo la migración 036 (cajas.empresa_id de acá arriba,
-- turnos_caja.caja_id, turnos_caja.empresa_id) se creó con ON DELETE
-- CASCADE -- sin este fix, borrar una empresa que tuviera aunque sea UN
-- turno registrado habría fallado con un error de foreign key ("no se puede
-- borrar cajas: turnos_caja todavía la referencia"), rompiendo esa función
-- de Super Admin en cuanto alguien usara esta sub-fase de verdad. Mismo
-- patrón que 031_eliminar_empresa_cascade.sql: DROP + ADD CONSTRAINT con el
-- mismo nombre por defecto de Postgres, seguro de re-correr.
ALTER TABLE cajas DROP CONSTRAINT IF EXISTS cajas_empresa_id_fkey;
ALTER TABLE cajas ADD CONSTRAINT cajas_empresa_id_fkey
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE;

ALTER TABLE turnos_caja DROP CONSTRAINT IF EXISTS turnos_caja_caja_id_fkey;
ALTER TABLE turnos_caja ADD CONSTRAINT turnos_caja_caja_id_fkey
  FOREIGN KEY (caja_id) REFERENCES cajas(id) ON DELETE CASCADE;

ALTER TABLE turnos_caja DROP CONSTRAINT IF EXISTS turnos_caja_empresa_id_fkey;
ALTER TABLE turnos_caja ADD CONSTRAINT turnos_caja_empresa_id_fkey
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE;

-- Tercer hallazgo, mismo espíritu: turnos_caja.usuario_apertura_id/
-- usuario_cierre_id referencian usuarios(id) sin ON DELETE -- igual que
-- audit_log antes de la migración 031, eso rompe cualquier borrado directo
-- de un usuario (la identidad global, no solo su membresía a una empresa)
-- apenas esa persona hubiera abierto o cerrado un turno alguna vez. Mismo
-- criterio que audit_log: SET NULL preserva la fila histórica del turno (el
-- monto, la fecha, el arqueo) aunque la cuenta que lo operó ya no exista --
-- por eso usuario_apertura_id deja de ser NOT NULL acá (usuario_cierre_id
-- ya era nullable desde la migración 036).
ALTER TABLE turnos_caja ALTER COLUMN usuario_apertura_id DROP NOT NULL;
ALTER TABLE turnos_caja DROP CONSTRAINT IF EXISTS turnos_caja_usuario_apertura_id_fkey;
ALTER TABLE turnos_caja ADD CONSTRAINT turnos_caja_usuario_apertura_id_fkey
  FOREIGN KEY (usuario_apertura_id) REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE turnos_caja DROP CONSTRAINT IF EXISTS turnos_caja_usuario_cierre_id_fkey;
ALTER TABLE turnos_caja ADD CONSTRAINT turnos_caja_usuario_cierre_id_fkey
  FOREIGN KEY (usuario_cierre_id) REFERENCES usuarios(id) ON DELETE SET NULL;

-- Como mucho un turno "abierto" por caja a la vez -- UNIQUE parcial
-- (solo sobre las filas en estado='abierto'), enforced en la base, no solo
-- en la app. src/routes/cajas.js igual hace su propio candado con
-- FOR UPDATE antes de llegar acá (para devolver un 409 con mensaje claro en
-- vez de un 500 de violación de constraint), pero esto es la garantía real
-- contra una carrera que ese candado no alcance a cubrir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_caja_unico_abierto ON turnos_caja (caja_id) WHERE estado = 'abierto';

-- Permisos del módulo -- mismo patrón que 037_permisos_sucursales.sql.
-- Abrir y cerrar turno usan AMBOS 'cajas.editar' (no un permiso aparte para
-- el ciclo de vida del turno) -- decisión explícita, ver conversación.
INSERT INTO permisos (nombre)
SELECT 'cajas.' || accion FROM (VALUES ('ver'), ('crear'), ('editar'), ('eliminar')) AS a(accion)
ON CONFLICT (nombre) DO NOTHING;

DO $$
DECLARE
  r_admin      INTEGER := (SELECT id FROM roles WHERE nombre = 'administrador');
  r_gerente    INTEGER := (SELECT id FROM roles WHERE nombre = 'gerente');
  r_ventas     INTEGER := (SELECT id FROM roles WHERE nombre = 'ventas');
  r_supervisor INTEGER := (SELECT id FROM roles WHERE nombre = 'supervisor');
BEGIN
  -- Administrador: control total.
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_admin, id FROM permisos WHERE nombre LIKE 'cajas.%'
  ON CONFLICT DO NOTHING;

  -- Gerente: ver/crear/editar (define cajas nuevas, y puede abrir/cerrar turno).
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_gerente, id FROM permisos WHERE nombre IN ('cajas.ver', 'cajas.crear', 'cajas.editar')
  ON CONFLICT DO NOTHING;

  -- Ventas: quienes de verdad abren/cierran turno día a día -- ver y editar
  -- (abrir/cerrar), pero no crear cajas nuevas (eso es más de configuración).
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_ventas, id FROM permisos WHERE nombre IN ('cajas.ver', 'cajas.editar')
  ON CONFLICT DO NOTHING;

  -- Supervisor: solo ver.
  IF r_supervisor IS NOT NULL THEN
    INSERT INTO rol_permiso (rol_id, permiso_id)
    SELECT r_supervisor, id FROM permisos WHERE nombre = 'cajas.ver'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
