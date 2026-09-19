-- Nivel 3 del roadmap competitivo: 2FA (TOTP -- Google Authenticator, Authy,
-- etc.) opcional por usuario, disponible solo en los planes con acceso_2fa
-- (hoy, Empresarial).
--
-- Los tres campos de usuarios son de la IDENTIDAD (global, igual que
-- password_hash): el 2FA se pide al entrar, antes de elegir empresa, así que
-- protege la cuenta en todas las empresas donde participa la persona.
--
--   totp_secreto_cifrado: el secreto TOTP cifrado (AES-256-GCM, ver src/totp.js
--     y TOTP_ENCRYPTION_KEY) -- nunca en claro. Mientras totp_activado_el sea
--     NULL es solo un secreto PENDIENTE de confirmar (el usuario ya lo vio,
--     todavía no probó un código): el login lo ignora.
--   totp_activado_el: NULL = 2FA apagado. Con valor = el login exige el código.
--   totp_ultimo_paso: último intervalo de 30 s ya aceptado. Cada código sirve
--     UNA vez -- sin esto, un código espiado podría reusarse durante los ~90 s
--     que dura su ventana de tolerancia.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_secreto_cifrado TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_activado_el TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_ultimo_paso BIGINT;

-- Códigos de recuperación (por si se pierde el celular): 10 por usuario, de un
-- solo uso. Solo se guarda un HMAC de cada uno (con una clave del servidor):
-- el código en claro se muestra UNA vez, al activar el 2FA.
CREATE TABLE IF NOT EXISTS codigos_recuperacion_2fa (
  id           SERIAL PRIMARY KEY,
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash  VARCHAR(64) NOT NULL,
  usado_el     TIMESTAMPTZ,
  creado_el    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_codigos_recuperacion_2fa_usuario ON codigos_recuperacion_2fa (usuario_id);

-- Mismo patrón deny-by-default que el resto de las tablas (ver 007_supabase_rls.sql).
ALTER TABLE codigos_recuperacion_2fa ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_recuperacion_2fa FORCE ROW LEVEL SECURITY;

-- Qué planes incluyen 2FA. migrate.js vuelve a correr TODOS los .sql en cada
-- `npm run migrate`, así que la semilla va dentro de este IF: solo se aplica
-- la primera vez que se crea la columna. Un UPDATE suelto reactivaría el
-- 2FA en Empresarial en cada corrida, pisando cualquier cambio hecho a mano.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'planes' AND column_name = 'acceso_2fa'
  ) THEN
    ALTER TABLE planes ADD COLUMN acceso_2fa BOOLEAN NOT NULL DEFAULT false;
    UPDATE planes SET acceso_2fa = true WHERE nombre = 'Empresarial';
  END IF;
END $$;
