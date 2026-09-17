-- Rename del módulo "Khipu AI" -> "GEALMI AI" (ver conflicto de marca,
-- memoria del proyecto). La 016_khipu_ai.sql NO se toca porque ya corrió en
-- producción -- este archivo hace el rename vía datos, no reescribe la 016.
--
-- modulos.id es referenciado por empresa_modulos.modulo_id (FK sin ON UPDATE
-- CASCADE, ver 012_empresas.sql), así que no se puede hacer un UPDATE directo
-- del id mientras haya filas hijas apuntando al valor viejo. Se resuelve
-- insertando la fila nueva, repuntando cualquier empresa que ya lo tuviera
-- habilitado, y recién ahí borrando la fila vieja. Los tres pasos son
-- idempotentes (igual que el resto de /migrations -- migrate.js corre todos
-- los .sql en cada `npm run migrate`, sin tabla de control de versiones).

INSERT INTO modulos (id, label, icon, page, base_de_datos)
SELECT 'gealmi_ai', 'GEALMI AI', icon, 'gealmi-ai.html', base_de_datos
FROM modulos WHERE id = 'khipu_ai'
ON CONFLICT (id) DO NOTHING;

UPDATE empresa_modulos SET modulo_id = 'gealmi_ai' WHERE modulo_id = 'khipu_ai';

DELETE FROM modulos WHERE id = 'khipu_ai';

-- permisos.nombre no es una FK por nombre (rol_permiso referencia permiso_id,
-- la PK numérica), así que renombrarla es un UPDATE simple y seguro.
UPDATE permisos SET nombre = 'gealmi_ai.ver' WHERE nombre = 'khipu_ai.ver';
