-- Paso 8 del backlog, fase R1: la ficha de empleado deja de ser "nombre, puesto
-- y sueldo" y pasa a llevar lo que RRHH necesita para todo lo demás (asistencia,
-- ausencias, remuneraciones, documentos): identidad, régimen laboral, contrato,
-- jornada pactada y el usuario de GEALMI con el que el trabajador marca su
-- propia asistencia.
--
-- Se AMPLÍA la tabla `empleados` (022); nada se recrea ni se renombra, así que
-- lo que ya hay (y el CSV de importación) sigue funcionando igual.
--
-- Idempotente a propósito: migrate.js vuelve a correr TODOS los .sql cada vez.

-- ---------------------------------------------------------------------------
-- Ficha ampliada
-- ---------------------------------------------------------------------------
ALTER TABLE empleados
  -- DNI (8 dígitos) o carnet de extranjería / pasaporte (letras y números).
  ADD COLUMN IF NOT EXISTS dni                          VARCHAR(12),
  ADD COLUMN IF NOT EXISTS fecha_nacimiento             DATE,
  ADD COLUMN IF NOT EXISTS direccion                    VARCHAR(250),
  -- Régimen laboral: define cuántos días de vacaciones corresponden y si hay
  -- gratificación/CTS (ver src/rrhh/calculos.js). 'general' es el régimen
  -- común; las MYPE tienen menos beneficios; 'otro' = a definir con el contador.
  ADD COLUMN IF NOT EXISTS regimen_laboral             VARCHAR(20) NOT NULL DEFAULT 'general',
  -- Texto libre a propósito ("plazo indeterminado", "plazo fijo", "part-time",
  -- "prácticas"...): la lista legal completa es larga y cambia por sector.
  ADD COLUMN IF NOT EXISTS tipo_contrato               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS fecha_fin_contrato          DATE,
  ADD COLUMN IF NOT EXISTS fecha_cese                  DATE,
  -- Jornada pactada. Con esto se calcula el sobretiempo y la tardanza en el
  -- registro de asistencia. Valores por defecto = jornada legal máxima (8 h)
  -- y refrigerio de 60 min; cada trabajador puede tener los suyos.
  ADD COLUMN IF NOT EXISTS jornada_horas_dia           NUMERIC(4,2) NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS hora_entrada                TIME,
  ADD COLUMN IF NOT EXISTS hora_salida                 TIME,
  ADD COLUMN IF NOT EXISTS refrigerio_minutos          INTEGER NOT NULL DEFAULT 60,
  -- Días de la semana que trabaja (1 = lunes ... 7 = domingo).
  ADD COLUMN IF NOT EXISTS dias_laborables             SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  -- Usuario de GEALMI de este trabajador (para que marque su asistencia desde
  -- "Mi asistencia"). SET NULL: si se borra la cuenta, la ficha se conserva.
  ADD COLUMN IF NOT EXISTS usuario_id                  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contacto_emergencia_nombre   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS contacto_emergencia_telefono VARCHAR(60);

-- CHECKs con nombre y guardados: ADD CONSTRAINT no tiene IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_empleados_regimen') THEN
    ALTER TABLE empleados ADD CONSTRAINT chk_empleados_regimen
      CHECK (regimen_laboral IN ('general', 'mype_micro', 'mype_pequena', 'otro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_empleados_jornada') THEN
    ALTER TABLE empleados ADD CONSTRAINT chk_empleados_jornada
      CHECK (jornada_horas_dia > 0 AND jornada_horas_dia <= 12);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_empleados_refrigerio') THEN
    ALTER TABLE empleados ADD CONSTRAINT chk_empleados_refrigerio
      CHECK (refrigerio_minutos BETWEEN 0 AND 240);
  END IF;
END $$;

-- Un usuario es UN trabajador por empresa, y un documento de identidad no se
-- repite dentro de la empresa. (Parciales: los NULL no cuentan.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_usuario_unico ON empleados (empresa_id, usuario_id) WHERE usuario_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_dni_unico     ON empleados (empresa_id, dni)        WHERE dni IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_empleados_fin_contrato         ON empleados (empresa_id, fecha_fin_contrato) WHERE fecha_fin_contrato IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Datos del empleador
-- ---------------------------------------------------------------------------
-- Van impresos en el "Registro de asistencia" (D.S. 004-2006-TR) y en lo que
-- se le entregue a un inspector: razón social, RUC y domicilio.
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS ruc              VARCHAR(11),
  ADD COLUMN IF NOT EXISTS razon_social     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS domicilio_fiscal VARCHAR(250);

-- ---------------------------------------------------------------------------
-- Permisos nuevos
-- ---------------------------------------------------------------------------
-- rrhh.remuneraciones: ver y editar sueldos, remuneraciones y beneficios.
--   Sin él, el sueldo del trabajador NO sale en la API (antes cualquiera con
--   rrhh.ver lo veía: p. ej. el supervisor).
-- rrhh.salud: información médica (detalle de descansos médicos, exámenes
--   médicos). Es dato sensible: solo el administrador.
INSERT INTO permisos (nombre) VALUES ('rrhh.remuneraciones'), ('rrhh.salud')
ON CONFLICT (nombre) DO NOTHING;

DO $$
DECLARE
  r_admin   INTEGER := (SELECT id FROM roles WHERE nombre = 'administrador');
  r_gerente INTEGER := (SELECT id FROM roles WHERE nombre = 'gerente');
BEGIN
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r, p.id
  FROM (VALUES (r_admin), (r_gerente)) AS roles_con_permiso(r)
  CROSS JOIN permisos p
  WHERE r IS NOT NULL AND p.nombre = 'rrhh.remuneraciones'
  ON CONFLICT DO NOTHING;

  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_admin, p.id FROM permisos p
  WHERE r_admin IS NOT NULL AND p.nombre = 'rrhh.salud'
  ON CONFLICT DO NOTHING;
END $$;
