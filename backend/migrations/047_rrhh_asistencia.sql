-- Paso 8, fase R2: registro de asistencia. Cada trabajador marca su entrada,
-- salida y refrigerio desde "Mi asistencia"; RRHH puede cargar o corregir a
-- mano (siempre con un motivo, y la corrección queda en Auditoría con el
-- antes y el después).
--
-- Una fila por trabajador y día. Las cuatro marcas son instantes (TIMESTAMPTZ)
-- tomados con la hora del SERVIDOR: el trabajador no puede poner la hora que
-- quiera al marcar. Un turno que cruza la medianoche cabe en una sola fila
-- (entrada a las 22:00, salida a las 06:00 del día siguiente).
--
-- El sobretiempo, la tardanza y las horas trabajadas NO se guardan: se calculan
-- al leer (src/rrhh/calculos.js), así un cambio en la jornada pactada o en una
-- marca se refleja sin tener que recalcular nada.
CREATE TABLE IF NOT EXISTS asistencias (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id        INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  -- Día calendario en Lima al que pertenece la jornada (el de la entrada).
  fecha              DATE NOT NULL,
  entrada            TIMESTAMPTZ,
  salida_refrigerio  TIMESTAMPTZ,
  retorno_refrigerio TIMESTAMPTZ,
  salida             TIMESTAMPTZ,
  -- 'marcacion' = la hizo el propio trabajador; 'manual' = la cargó/corrigió RRHH.
  origen             VARCHAR(12) NOT NULL DEFAULT 'marcacion' CHECK (origen IN ('marcacion', 'manual')),
  -- Motivo (obligatorio cuando origen = 'manual'; lo exige la API).
  observacion        VARCHAR(250),
  registrado_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empleado_id, fecha),
  CHECK (salida IS NULL OR entrada IS NULL OR salida >= entrada)
);

CREATE INDEX IF NOT EXISTS idx_asistencias_empresa_fecha ON asistencias (empresa_id, fecha);
-- Para hallar la jornada abierta (sin salida) de un trabajador al marcar.
CREATE INDEX IF NOT EXISTS idx_asistencias_abiertas ON asistencias (empleado_id, entrada DESC) WHERE salida IS NULL;

ALTER TABLE asistencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE asistencias FORCE ROW LEVEL SECURITY;
