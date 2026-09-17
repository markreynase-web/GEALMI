-- Fase 3 -- Nivel 1 (Urgente) del roadmap competitivo: límite de usuarios
-- por plan, aplicado de verdad. Esqueleto MÍNIMO de "planes" a propósito --
-- solo lo que hace falta para el candado de usuarios hoy (limite_usuarios).
-- Cuando se construya el sistema completo de Contratación/Suscripciones
-- (ver el documento de esa fase), esta tabla gana columnas (precio,
-- módulos incluidos, etc.), nunca se recrea desde cero.
--
-- limite_usuarios NULL = sin límite (Profesional/Empresarial hoy).
CREATE TABLE IF NOT EXISTS planes (
  id                SERIAL PRIMARY KEY,
  nombre            VARCHAR(50) NOT NULL UNIQUE,
  limite_usuarios   INTEGER,
  creado_el         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- empresas.plan_id nullable a propósito: una empresa sin plan asignado
-- (todas las existentes, hoy) se comporta exactamente como antes de esta
-- migración -- sin límite -- en vez de romperse por falta de dato.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES planes(id);

-- Semilla de los 3 planes actuales de GEALMI. Los valores de
-- limite_usuarios son un punto de partida editable (vía
-- PUT /api/superadmin/planes/:id más adelante, o SQL directo por ahora),
-- no una decisión comercial definitiva.
INSERT INTO planes (nombre, limite_usuarios) VALUES
  ('Básico', 4),
  ('Profesional', NULL),
  ('Empresarial', NULL)
ON CONFLICT (nombre) DO NOTHING;

-- Mismo patrón deny-by-default que el resto de las tablas (ver
-- 007_supabase_rls.sql).
ALTER TABLE planes ENABLE ROW LEVEL SECURITY;
ALTER TABLE planes FORCE ROW LEVEL SECURITY;
