-- Personalización de marca por empresa: un solo color primario (hex), que
-- el frontend usa para sobreescribir --ochre/--ochre-deep (las variables
-- CSS que ya manejan botones primarios, estados activos del sidebar, etc.)
-- Nula = usa el color de GEALMI por defecto (el de css/base.css), sin
-- tocar nada.
--
-- A propósito UN solo color, no un tema completo -- personalizar layout o
-- qué se muestra queda fuera de alcance (decisión explícita, ver charla con
-- el usuario): esto es "cambia el color de marca", no "arma tu propia UI".
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS color_primario VARCHAR(7);
