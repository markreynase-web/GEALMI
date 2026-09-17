-- Nivel 3 del roadmap competitivo: API pública de solo lectura + exportación
-- de datos. Autenticación con API keys (no el JWT de sesión -- esas
-- expiran en 8h y son por persona; una integración de terceros necesita
-- algo de larga duración, por empresa, revocable).
--
-- Formato de la key real (nunca se guarda completa): "gealmi_" + 40
-- caracteres hex al azar. "prefijo" guarda los primeros 12 caracteres de la
-- parte aleatoria SIN el hash -- no es secreto por sí solo (con eso nadie
-- puede autenticarse), sirve solo para poder buscar la fila rápido (índice)
-- sin tener que comparar bcrypt contra cada key de la base, y para que la
-- pantalla de "Mis API keys" pueda mostrar algo que identifique cada key
-- sin volver a mostrar la key completa (mismo criterio que usan Stripe/GitHub
-- con sus tokens). "key_hash" es la key COMPLETA hasheada con bcrypt, mismo
-- mecanismo que usuarios.password_hash.
CREATE TABLE IF NOT EXISTS api_keys (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre         VARCHAR(100) NOT NULL,
  prefijo        VARCHAR(20) NOT NULL,
  key_hash       VARCHAR(255) NOT NULL,
  creado_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_el  TIMESTAMPTZ,
  activa         BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_api_keys_empresa ON api_keys (empresa_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefijo ON api_keys (prefijo);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Gating por plan: "Exportación de datos + API" ya se promete en la landing
-- como beneficio de Profesional. false por defecto -- Básico se queda solo
-- con la exportación CSV dentro de la app (no necesita esta columna).
ALTER TABLE planes ADD COLUMN IF NOT EXISTS acceso_api BOOLEAN NOT NULL DEFAULT false;
UPDATE planes SET acceso_api = true WHERE nombre IN ('Profesional', 'Empresarial');

-- Permisos para la pantalla de gestión de API keys (routes/apiKeys.js) --
-- mismo patrón que sucursales/cajas (037/040): transversal, no depende de
-- un módulo contratado, solo de rol.
INSERT INTO permisos (nombre) VALUES
  ('api_keys.ver'), ('api_keys.crear'), ('api_keys.eliminar')
ON CONFLICT (nombre) DO NOTHING;

DO $$
DECLARE
  r_admin   INTEGER := (SELECT id FROM roles WHERE nombre = 'administrador');
  r_gerente INTEGER := (SELECT id FROM roles WHERE nombre = 'gerente');
BEGIN
  -- Administrador: control total (crear y revocar keys -- acceso a
  -- integraciones externas es sensible, no se reparte más abajo del
  -- administrador/gerente).
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_admin, id FROM permisos WHERE nombre LIKE 'api_keys.%'
  ON CONFLICT DO NOTHING;

  -- Gerente: ver y crear, no revocar (una key que ya está en uso por una
  -- integración de un tercero no la debería poder cortar cualquiera con
  -- acceso de gerente sin pensarlo -- mismo criterio que "sin eliminar"
  -- que ya usa este rol en el resto de módulos).
  INSERT INTO rol_permiso (rol_id, permiso_id)
  SELECT r_gerente, id FROM permisos WHERE nombre IN ('api_keys.ver', 'api_keys.crear')
  ON CONFLICT DO NOTHING;
END $$;
