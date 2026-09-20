-- Paso 8, fase R7: reclutamiento. Vacantes y candidatos con un embudo simple
-- (postulado → entrevista → prueba → oferta → contratado / descartado). Al
-- contratar a un candidato se crea su ficha de empleado (POST
-- /api/rrhh/candidatos/:id/contratar) y queda enlazada aquí.
CREATE TABLE IF NOT EXISTS vacantes (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  titulo            VARCHAR(150) NOT NULL,
  departamento      VARCHAR(100),
  descripcion       TEXT,
  -- Cuántas personas se buscan para este puesto.
  cantidad          INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  estado            VARCHAR(10) NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'pausada', 'cerrada')),
  fecha_publicacion DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_cierre      DATE,
  creado_el         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacantes_empresa_estado ON vacantes (empresa_id, estado);

CREATE TABLE IF NOT EXISTS candidatos (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  vacante_id          INTEGER NOT NULL REFERENCES vacantes(id) ON DELETE CASCADE,
  nombre              VARCHAR(200) NOT NULL,
  email               VARCHAR(200),
  telefono            VARCHAR(60),
  dni                 VARCHAR(12),
  -- Enlace al CV (Drive, etc.); igual que en el legajo, solo https.
  cv_url              VARCHAR(500),
  fuente              VARCHAR(60),
  etapa               VARCHAR(12) NOT NULL DEFAULT 'postulado' CHECK (etapa IN ('postulado', 'entrevista', 'prueba', 'oferta', 'contratado', 'descartado')),
  pretension_salarial NUMERIC(12,2) CHECK (pretension_salarial IS NULL OR pretension_salarial >= 0),
  notas               TEXT,
  -- Se llena al contratarlo. SET NULL: si luego borran la ficha, el candidato se conserva.
  empleado_id         INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  creado_el           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidatos_vacante ON candidatos (vacante_id, etapa);
CREATE INDEX IF NOT EXISTS idx_candidatos_empresa ON candidatos (empresa_id);

ALTER TABLE vacantes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacantes   FORCE ROW LEVEL SECURITY;
ALTER TABLE candidatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidatos FORCE ROW LEVEL SECURITY;
