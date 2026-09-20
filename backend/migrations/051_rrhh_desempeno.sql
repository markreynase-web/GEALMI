-- Paso 8, fase R6: desempeño. Evaluaciones con cinco criterios fijos (1 a 5) y
-- capacitaciones con sus participantes.
--
-- Los criterios son FIJOS a propósito: una plantilla configurable (criterios
-- propios, pesos, escalas) es un producto en sí mismo; con cinco criterios
-- comunes ya se puede comparar a la gente y ver quién mejora o empeora.
CREATE TABLE IF NOT EXISTS evaluaciones (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id      INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  -- Etiqueta libre del período: "2026-S1", "Prueba de 3 meses", "Anual 2026".
  periodo          VARCHAR(40) NOT NULL,
  fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Quién evaluó. SET NULL + nombre congelado al lado: mismo criterio que audit_log.
  evaluador_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  evaluador_nombre VARCHAR(100),
  puntualidad      SMALLINT NOT NULL CHECK (puntualidad BETWEEN 1 AND 5),
  calidad_trabajo  SMALLINT NOT NULL CHECK (calidad_trabajo BETWEEN 1 AND 5),
  trabajo_equipo   SMALLINT NOT NULL CHECK (trabajo_equipo BETWEEN 1 AND 5),
  iniciativa       SMALLINT NOT NULL CHECK (iniciativa BETWEEN 1 AND 5),
  comunicacion     SMALLINT NOT NULL CHECK (comunicacion BETWEEN 1 AND 5),
  promedio         NUMERIC(3,2) GENERATED ALWAYS AS ((puntualidad + calidad_trabajo + trabajo_equipo + iniciativa + comunicacion) / 5.0) STORED,
  fortalezas       TEXT,
  oportunidades    TEXT,
  creado_el        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_empleado ON evaluaciones (empleado_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_empresa  ON evaluaciones (empresa_id, fecha DESC);

CREATE TABLE IF NOT EXISTS capacitaciones (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre         VARCHAR(150) NOT NULL,
  proveedor      VARCHAR(150),
  fecha          DATE NOT NULL DEFAULT CURRENT_DATE,
  horas          NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (horas >= 0),
  costo          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),
  -- Obligatoria (p. ej. seguridad y salud en el trabajo): pesa distinto en el reporte.
  obligatoria    BOOLEAN NOT NULL DEFAULT false,
  notas          VARCHAR(250),
  creado_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capacitaciones_empresa_fecha ON capacitaciones (empresa_id, fecha DESC);

CREATE TABLE IF NOT EXISTS capacitacion_participantes (
  capacitacion_id INTEGER NOT NULL REFERENCES capacitaciones(id) ON DELETE CASCADE,
  empleado_id     INTEGER NOT NULL REFERENCES empleados(id)      ON DELETE CASCADE,
  -- Redundante con capacitacion_id, pero deja filtrar por empresa sin un JOIN.
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id)       ON DELETE CASCADE,
  asistio         BOOLEAN NOT NULL DEFAULT false,
  certificado_url VARCHAR(500),
  PRIMARY KEY (capacitacion_id, empleado_id)
);
CREATE INDEX IF NOT EXISTS idx_capacitacion_part_empleado ON capacitacion_participantes (empleado_id);

ALTER TABLE evaluaciones               ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluaciones               FORCE ROW LEVEL SECURITY;
ALTER TABLE capacitaciones             ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacitaciones             FORCE ROW LEVEL SECURITY;
ALTER TABLE capacitacion_participantes ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacitacion_participantes FORCE ROW LEVEL SECURITY;
