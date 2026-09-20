-- Paso 8, fase R3: ausencias (vacaciones, descansos médicos, licencias y
-- permisos) con flujo de aprobación. El trabajador la solicita desde "Mi
-- asistencia" (queda 'pendiente'); RRHH la aprueba o la rechaza. Lo que RRHH
-- carga a mano puede nacer ya 'aprobada'.
--
-- Solo lo APROBADO cuenta: descuenta el saldo de vacaciones y hace que el
-- trabajador figure "de vacaciones" / "de licencia" en su ficha durante esas
-- fechas (estado efectivo; ver routes/rrhh.js), sin tocar `empleados.estado`.
CREATE TABLE IF NOT EXISTS ausencias (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id           INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo                  VARCHAR(20) NOT NULL CHECK (tipo IN ('vacaciones', 'descanso_medico', 'licencia', 'permiso')),
  fecha_inicio          DATE NOT NULL,
  fecha_fin             DATE NOT NULL,
  -- Días calendario entre las dos fechas, ambas incluidas (los calcula la API).
  dias                  INTEGER NOT NULL CHECK (dias > 0),
  -- ¿La ausencia se paga? (vacaciones y descanso médico cubierto = sí; permiso sin goce = no).
  con_goce              BOOLEAN NOT NULL DEFAULT true,
  estado                VARCHAR(10) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  motivo                VARCHAR(250),
  -- Diagnóstico o CITT: dato de salud. Solo se lee/escribe con rrhh.salud.
  detalle_medico        TEXT,
  solicitado_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelto_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelto_el           TIMESTAMPTZ,
  comentario_resolucion VARCHAR(250),
  creado_el             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fecha_fin >= fecha_inicio)
);

CREATE INDEX IF NOT EXISTS idx_ausencias_empresa_inicio  ON ausencias (empresa_id, fecha_inicio);
CREATE INDEX IF NOT EXISTS idx_ausencias_empleado_fechas ON ausencias (empleado_id, fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_ausencias_pendientes      ON ausencias (empresa_id) WHERE estado = 'pendiente';

ALTER TABLE ausencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE ausencias FORCE ROW LEVEL SECURITY;
