-- Paso 7 del backlog: GEALMI AI pasa de widget flotante a módulo con página
-- propia, y las conversaciones se GUARDAN (antes el chat vivía solo en el
-- navegador y se perdía al recargar; ver la política de privacidad, sección 8:
-- "las solicitudes y respuestas podrán conservarse... para mantener el historial
-- de la funcionalidad").
--
-- Cada conversación es PRIVADA de quien la tuvo: se lee y se borra solo con su
-- usuario_id (ni un administrador de la empresa las ve desde la API). Guardarlas
-- del lado del servidor tiene una ventaja de seguridad: el servidor arma el
-- historial que le manda al modelo desde SU base, ya no desde lo que diga el
-- cliente, así que nadie puede fabricar un turno "assistant" falso para
-- envenenar la conversación (el riesgo que documentaba src/gealmiAiHistorial.js).
CREATE TABLE IF NOT EXISTS gealmi_ai_conversaciones (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo         VARCHAR(120) NOT NULL,
  creada_el      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada_el TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gealmi_ai_conv_usuario ON gealmi_ai_conversaciones (usuario_id, actualizada_el DESC);
CREATE INDEX IF NOT EXISTS idx_gealmi_ai_conv_empresa ON gealmi_ai_conversaciones (empresa_id);

CREATE TABLE IF NOT EXISTS gealmi_ai_mensajes (
  id              SERIAL PRIMARY KEY,
  conversacion_id INTEGER NOT NULL REFERENCES gealmi_ai_conversaciones(id) ON DELETE CASCADE,
  rol             VARCHAR(10) NOT NULL CHECK (rol IN ('user', 'assistant')),
  texto           TEXT NOT NULL,
  -- Qué herramientas de datos consultó la IA para esa respuesta (para "Consulté: ...").
  herramientas    TEXT[] NOT NULL DEFAULT '{}',
  creado_el       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gealmi_ai_msg_conv ON gealmi_ai_mensajes (conversacion_id, id);

ALTER TABLE gealmi_ai_conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE gealmi_ai_conversaciones FORCE ROW LEVEL SECURITY;
ALTER TABLE gealmi_ai_mensajes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gealmi_ai_mensajes FORCE ROW LEVEL SECURITY;
