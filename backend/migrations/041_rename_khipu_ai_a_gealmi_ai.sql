-- Rename del módulo "Khipu AI" -> "GEALMI AI" (ver conflicto de marca,
-- memoria del proyecto). La 016_khipu_ai.sql NO se toca porque ya corrió en
-- producción -- este archivo hace el rename vía datos, no reescribe la 016.
--
-- modulos.id es referenciado por empresa_modulos.modulo_id (FK sin ON UPDATE
-- CASCADE, ver 012_empresas.sql), así que no se puede hacer un UPDATE directo
-- del id mientras haya filas hijas apuntando al valor viejo. Se resuelve
-- insertando la fila nueva, repuntando cualquier empresa que ya lo tuviera
-- habilitado, y recién ahí borrando la fila vieja.
--
-- CORRECCIÓN (post primera corrida en producción): 016_khipu_ai.sql vuelve a
-- sembrar 'khipu_ai' (modulos) y 'khipu_ai.ver' (permisos) en CADA corrida
-- completa de migrate.js -- ON CONFLICT DO NOTHING solo evita duplicados,
-- no evita que una fila resucite después de haber sido borrada/renombrada
-- acá. El lado de "modulos" ya era seguro (INSERT choca por PK, DELETE no
-- choca con nada), pero el UPDATE de permisos SÍ chocaba: en la segunda
-- corrida ya existe 'gealmi_ai.ver' (de la primera) y 016 vuelve a crear
-- 'khipu_ai.ver', así que el rename pisaba una fila ya ocupada
-- (permisos_nombre_key). Se agregó el DELETE de abajo para dejar los cuatro
-- pasos realmente idempotentes (igual que el resto de /migrations --
-- migrate.js corre todos los .sql en cada `npm run migrate`, sin tabla de
-- control de versiones).

INSERT INTO modulos (id, label, icon, page, base_de_datos)
SELECT 'gealmi_ai', 'GEALMI AI', icon, 'gealmi-ai.html', base_de_datos
FROM modulos WHERE id = 'khipu_ai'
ON CONFLICT (id) DO NOTHING;

UPDATE empresa_modulos SET modulo_id = 'gealmi_ai' WHERE modulo_id = 'khipu_ai';

DELETE FROM modulos WHERE id = 'khipu_ai';

-- permisos.nombre no es una FK por nombre (rol_permiso referencia permiso_id,
-- la PK numérica), así que renombrarla es un UPDATE simple y seguro -- pero
-- primero hay que limpiar cualquier 'khipu_ai.ver' resucitado por 016 en
-- esta misma corrida, si el destino del rename ya existe (rol_permiso de esa
-- fila resucitada se borra en cascada, sin pérdida real: los permisos que
-- importan son los de la fila 'gealmi_ai.ver' original, que nunca se toca).
DELETE FROM permisos
WHERE nombre = 'khipu_ai.ver'
  AND EXISTS (SELECT 1 FROM permisos WHERE nombre = 'gealmi_ai.ver');

UPDATE permisos SET nombre = 'gealmi_ai.ver' WHERE nombre = 'khipu_ai.ver';
