-- Paso 8, fase R4: remuneraciones. Es un REGISTRO de lo que se paga a cada
-- trabajador mes a mes y del historial de sus aumentos -- no es una planilla
-- electrónica ni calcula AFP/ONP/renta de 5.ª categoría (eso es del contador).
-- Todo lo que sea estimado (gratificación, CTS) se calcula al vuelo y se marca
-- como referencial (src/rrhh/calculos.js); nunca se guarda como verdad.
--
-- Todo esto pide el permiso rrhh.remuneraciones (046).

-- Cada vez que cambia el sueldo de la ficha queda una fila aquí.
CREATE TABLE IF NOT EXISTS historial_salarial (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id     INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  sueldo_anterior NUMERIC(12,2),
  sueldo_nuevo    NUMERIC(12,2) NOT NULL CHECK (sueldo_nuevo >= 0),
  vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
  motivo          VARCHAR(200),
  registrado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_salarial_empleado ON historial_salarial (empleado_id, vigente_desde DESC);
CREATE INDEX IF NOT EXISTS idx_historial_salarial_empresa  ON historial_salarial (empresa_id);

-- Un pago mensual por trabajador. El neto lo calcula la base: no puede quedar
-- descuadrado con sus componentes.
CREATE TABLE IF NOT EXISTS remuneraciones (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id    INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  -- Mes al que corresponde, 'AAAA-MM'.
  periodo        VARCHAR(7) NOT NULL CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  sueldo_base    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sueldo_base >= 0),
  bonificaciones NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bonificaciones >= 0),
  horas_extra    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (horas_extra >= 0),
  descuentos     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (descuentos >= 0),
  neto           NUMERIC(12,2) GENERATED ALWAYS AS (sueldo_base + bonificaciones + horas_extra - descuentos) STORED,
  estado         VARCHAR(10) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado')),
  fecha_pago     DATE,
  notas          VARCHAR(250),
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empleado_id, periodo)
);
CREATE INDEX IF NOT EXISTS idx_remuneraciones_empresa_periodo ON remuneraciones (empresa_id, periodo);

ALTER TABLE historial_salarial ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_salarial FORCE ROW LEVEL SECURITY;
ALTER TABLE remuneraciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE remuneraciones     FORCE ROW LEVEL SECURITY;
