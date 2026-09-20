-- Paso 8, fase R5: legajo digital. Por cada trabajador, sus documentos
-- (contrato, DNI, CV, certificados, examen médico...) con fecha de vencimiento
-- para poder avisar antes de que caduquen (ver src/notificaciones.js).
--
-- GEALMI NO guarda los archivos: guarda el ENLACE (Drive, OneDrive, etc.). Así
-- no hay que cobrar almacenamiento ni proteger archivos sensibles aquí. La API
-- solo acepta enlaces https.
CREATE TABLE IF NOT EXISTS documentos_empleado (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  empleado_id       INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  -- 'examen_medico' es dato de salud: solo se ve/edita con rrhh.salud.
  tipo              VARCHAR(30) NOT NULL CHECK (tipo IN ('contrato', 'dni', 'cv', 'certificado', 'examen_medico', 'antecedentes', 'declaracion_jurada', 'otro')),
  nombre            VARCHAR(150) NOT NULL,
  url               VARCHAR(500),
  fecha_emision     DATE,
  fecha_vencimiento DATE,
  notas             VARCHAR(250),
  subido_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_el    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documentos_empleado_ficha   ON documentos_empleado (empleado_id);
CREATE INDEX IF NOT EXISTS idx_documentos_empleado_vence   ON documentos_empleado (empresa_id, fecha_vencimiento) WHERE fecha_vencimiento IS NOT NULL;

ALTER TABLE documentos_empleado ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentos_empleado FORCE ROW LEVEL SECURITY;
