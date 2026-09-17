# Backup y restauración de GEALMI

```
Base de origen (DATABASE_URL / BACKUP_DATABASE_URL)
        |
        v
   pg_dump -Fc -n public
        |
        v
  archivo .dump (BACKUP_DIR)
        |
        v
almacenamiento externo (fuera del repo/servidor)
        |
        v
   pg_restore -l  ->  inspeccionar TOC  ->  filtrar exclusiones (ver más abajo)
        |
        v
   pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction [-L lista_filtrada]
        |
        v
  base aislada (RESTORE_TARGET_URL)
        |
        v
validación de datos restaurados (hash + integridad + funcional + secuencias + RLS)
```

## Estado real

**Backup y restore fueron ejecutados y validados end-to-end de verdad**, contra una base de testing real (`TEST_DATABASE_URL`, Supabase), en la Fase 1 de estabilización. No es una implementación teórica: se sembró un dataset QA-DR, se hizo backup real, se simuló una pérdida real, y se restauró con éxito -- con evidencia verificable en cada paso (ver "Validación de una restauración" y "Lección de los intentos fallidos" más abajo).

`scripts/backup.js` y `scripts/restore.js` usan `pg_dump`/`pg_restore` reales -- ninguna implementación alternativa con SQL manual. Las PostgreSQL Client Tools (v17.11) están instaladas en el entorno de desarrollo (solo "Command Line Tools", sin servidor local -- ver auditoría de instalación de la Fase 1).

## Backup

```
DATABASE_URL=<la de siempre>              # o BACKUP_DATABASE_URL=<override explícito>
BACKUP_DIR=./backups                       # opcional, por defecto ./backups
npm run backup
```

- **Origen configurable**: si `BACKUP_DATABASE_URL` está definida, se usa esa (pensado para respaldar puntualmente un entorno distinto, ej. `TEST_DATABASE_URL`, sin sobrescribir `DATABASE_URL`). Si no, cae a `DATABASE_URL` -- comportamiento normal/futuro sin cambios. Si ambas están definidas y son idénticas, el script aborta (evita un override redundante que suele ser una URL pegada por error).
- Formato `-Fc -n public` (custom, comprimido, **acotado al schema `public`**). El `-n public` es importante: sin él, un dump completo de una base Supabase puede incluir schemas internos de la plataforma (`auth`, `storage`, `realtime`, etc.) a los que el rol de conexión tenga acceso -- innecesario y un radio de impacto mayor al que hace falta, ya que toda la aplicación real de GEALMI vive en `public`.
- Nombre de archivo con timestamp ISO: `gealmi-postgres-2026-08-25T....dump`.
- La contraseña nunca se pasa como argumento de proceso ni se imprime en consola -- se traduce a variables de entorno libpq (`PGPASSWORD`, etc.) antes de invocar `pg_dump`.
- Si `pg_dump` no está instalado, el script falla explícitamente -- nunca hace un backup "de mentira".
- **Verificación obligatoria post-backup**: exit code 0, el archivo existe, tamaño > 0, y SHA-256 del `.dump` calculado y registrado -- se vuelve a verificar ese mismo hash justo antes de cada intento de restore, para confirmar que el archivo no cambió entre medio.

## Restauración

```
RESTORE_TARGET_URL=<base de destino, EXPLÍCITA y AISLADA -- nunca producción>
RESTORE_LIST_FILE=<opcional: lista TOC filtrada, ver sección de exclusiones>
npm run restore -- ./backups/gealmi-postgres-....dump
```

- `RESTORE_TARGET_URL` es obligatoria, sin fallback a `DATABASE_URL`. Si coincide con `DATABASE_URL`, el script se niega a correr.
- **Regla de seguridad al invocar**: para que esa comparación sea significativa, `DATABASE_URL` debe conservar su valor real (producción) en el entorno del comando -- nunca sobrescribirla "para simplificar", ni siquiera temporalmente, al mismo tiempo que se define `RESTORE_TARGET_URL`.
- `--clean --if-exists --no-owner --exit-on-error --single-transaction`:
  - `--clean --if-exists`: deja el destino en el mismo estado que el dump.
  - `--exit-on-error --single-transaction`: restauración **todo o nada**. Cualquier error revierte el restore completo (ROLLBACK), dejando la base exactamente como estaba antes del intento -- nunca un resultado parcialmente aplicado. Validado en la práctica: ver "Lección de los intentos fallidos".
- `RESTORE_LIST_FILE` (opcional): si se define, se agrega `-L <archivo>` a `pg_restore` para restaurar solo las entradas de esa lista en vez del dump completo. Sirve para excluir a mano entradas puntuales del TOC (ver sección siguiente). La lista filtrada es siempre un artefacto explícito de cada corrida (generado con `pg_restore -l` + edición), nunca algo que el script decida solo -- `restore.js` no tiene ninguna lógica que excluya objetos por su cuenta.
- **No ejecutar nunca `DROP SCHEMA public` (ni manualmente, ni dejando que `--clean` lo intente sin control) contra producción.** Ver la sección de exclusiones: es exactamente ese comando el que causó el primer fallo real documentado abajo.

## Exclusiones de TOC necesarias en un entorno Supabase administrado

Restaurar un dump completo (`-Fc -n public`) con `pg_restore --clean` contra una base Supabase real **no funciona a ciegas** -- hacen falta 6 exclusiones puntuales del TOC, identificadas y validadas en la Fase 1:

| # | Entrada excluida | Motivo técnico |
|---|---|---|
| 1 | `SCHEMA - public` | `--clean` intenta `DROP SCHEMA IF EXISTS public;` antes de recrearlo. En Supabase, la extensión `unaccent` (usada por la búsqueda de GEALMI, migración 029) vive **dentro** del schema `public` -- Postgres rechaza el DROP porque hay un objeto dependiente, y `pg_restore` no agrega `CASCADE` por defecto. |
| 2 | `COMMENT - SCHEMA public` | Metadata asociada al mismo objeto schema del punto 1 -- se cae junto con él. |
| 3 | `ACL - SCHEMA public` | Idem -- permisos del objeto schema, no de las tablas. |
| 4 | `DEFAULT ACL ... FOR TABLES supabase_admin` | `pg_dump` captura, además de los privilegios por defecto que puso nuestro propio rol (`postgres`), los que puso `supabase_admin` (rol de plataforma de Supabase) sobre objetos futuros en `public`. Nuestro rol de conexión (`postgres`, con `BYPASSRLS` pero **sin ser superusuario**) no tiene autoridad para modificar privilegios por defecto establecidos por otro rol -- Postgres exige ser ese rol o superusuario. |
| 5 | `DEFAULT ACL ... FOR FUNCTIONS supabase_admin` | Mismo motivo que el punto 4, para funciones. |
| 6 | `DEFAULT ACL ... FOR SEQUENCES supabase_admin` | Mismo motivo que el punto 4, para secuencias. |

**Estas 6 exclusiones NO significan pérdida de tablas, datos, constraints, índices, RLS ni lógica de aplicación.** Son exclusivamente objetos de gestión de plataforma (el schema `public` como objeto en sí, y privilegios por defecto de un rol administrativo de Supabase) -- ninguno de los dos es responsabilidad de GEALMI ni hace falta para reconstruir su esquema o sus datos. Las 3 entradas `DEFAULT ACL ... postgres` (nuestro propio rol) **sí se conservan e incluyen** en el restore.

Confirmado por la evidencia real de la Fase 1: con estas 6 exclusiones, el restore recuperó **exactamente** el estado pre-pérdida --
- hash global de datos PRE == POST (comparación determinista por tabla y fila);
- 0 registros huérfanos en las relaciones verificadas (usuario_empresa, clientes, inventario, mascotas, ventas, finanzas);
- 0 constraints `NOT VALID` en el schema `public`;
- estado de negocio correcto (stock, montos de finanzas, `compras_totales`, mascota asociada);
- las 7 secuencias verificadas en `last_value == max(id)`, sin riesgo de colisión;
- RLS habilitado y forzado en las 43/43 tablas de `public`, igual que antes de la pérdida;
- verificación funcional por HTTP real (login, aislamiento entre empresas, venta restaurada) en PASS.

**Procedimiento para generar la lista filtrada** (manual, deliberado -- no un flag que decida solo):
```
pg_restore -l archivo.dump > restore_toc.list
# editar restore_toc.list: quitar únicamente las 6 líneas de la tabla de arriba
# (o las que correspondan al entorno -- inspeccionar el TOC real antes de asumir que son las mismas 6)
# guardar como restore_toc_filtered.list
RESTORE_LIST_FILE=restore_toc_filtered.list RESTORE_TARGET_URL=... node scripts/restore.js archivo.dump
```

## Lección de los intentos fallidos (evidencia real, no oculta)

El restore que finalmente funcionó fue el **tercer intento**. Los dos primeros fallaron de forma real, y quedan documentados a propósito -- son parte de la evidencia de que el procedimiento (en particular `--single-transaction`) protege la base incluso cuando algo sale mal:

1. **Intento 1** -- `pg_restore --clean` sin lista filtrada: falló con `cannot drop schema public because other objects depend on it / DETAIL: extension unaccent depends on schema public`. `--single-transaction` revirtió todo (ROLLBACK) -- verificado después: las 43 tablas, `unaccent`, los roles y el seed de la migración 012 seguían intactos, sin ningún cambio parcial.
2. **Intento 2** -- con la primera lista filtrada (3 exclusiones de `SCHEMA public`): falló con `permission denied to change default privileges / Command was: ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ...`. Mismo resultado: `--single-transaction` revirtió todo limpiamente, base verificada intacta de nuevo.
3. **Intento 3** -- con la lista filtrada final (6 exclusiones, tabla de arriba): `pg_restore` terminó con **exit code 0**, y la validación posterior completa (hash, integridad, negocio, secuencias, RLS, funcional) dio PASS en todo.

Ninguno de los dos fallos causó pérdida ni corrupción de datos -- eso es precisamente lo que se buscaba demostrar al exigir `--single-transaction`.

## Validación de una restauración (obligatoria antes de dar esto por cerrado)

No alcanza con que `pg_restore` devuelva exit code 0. Checklist real, ejecutado y confirmado en la Fase 1:

1. **Hash determinista PRE vs. POST** -- snapshot de las tablas/filas relevantes antes del backup y después del restore, columnas explícitas y orden fijo, SHA-256 por tabla y global. Coincidencia exacta, no aproximada.
2. **Integridad referencial** -- cero huérfanos en cada relación real de la aplicación (no genérico): `usuario_empresa→empresas`, `clientes→empresas`, `inventario→empresas`, `mascotas→empresas/clientes`, `ventas→clientes/inventario` (misma empresa), `finanzas→ventas`. Más: cero constraints `NOT VALID` en `public`.
3. **Estado de negocio con queries dedicadas** (no solo el hash) -- valores concretos: stock, montos de `finanzas`, `compras_totales`, existencia y datos de un registro de un módulo vertical (mascota).
4. **Secuencias** -- `last_value`/`is_called` de cada secuencia relevante comparado contra `max(id)` real de su tabla; confirmar que el próximo `INSERT` no puede colisionar con un ID restaurado.
5. **RLS** -- `relrowsecurity`/`relforcerowsecurity` de cada tabla, comparado contra el estado documentado antes de la pérdida (43/43 tablas en este proyecto).
6. **Verificación funcional real por HTTP** -- servidor real, login real, y al menos una prueba positiva (dato propio visible) y una negativa (dato ajeno NO visible) de aislamiento multiempresa.

## Reglas de seguridad del procedimiento

- **Nunca ejecutar un restore contra `DATABASE_URL` de producción sin autorización explícita** -- el guardia de `restore.js` (`RESTORE_TARGET_URL !== DATABASE_URL`) es la última barrera automática, no la única: la decisión de a qué apunta `RESTORE_TARGET_URL` sigue siendo humana en cada corrida.
- Preferir siempre `TEST_DATABASE_URL` para validar el procedimiento completo antes de siquiera considerar un escenario real.
- Usar `--exit-on-error --single-transaction` siempre que la base de destino lo permita (tamaño/duración razonables) -- es lo que convierte un restore fallido en "sin efecto" en vez de "a medias".
- Verificar SHA-256 del `.dump` antes de cada intento de restore, no solo una vez al hacer el backup.
- No dar un restore por exitoso solo porque `pg_restore` terminó con exit code 0 -- correr siempre el checklist completo de la sección anterior.
- Inspeccionar el TOC (`pg_restore -l`) de cualquier dump nuevo antes de restaurarlo contra una base Supabase real -- las 6 exclusiones documentadas arriba fueron correctas para este proyecto/entorno, pero deben reverificarse si cambia la versión de Postgres, el proveedor, o la configuración de extensiones/roles de la base de destino.

## Programación externa (para más adelante, no parte de esta fase)

Sin infraestructura nueva todavía -- opciones evaluadas para cuando se decida programarlo:

- **Render Cron Job**: el backend ya vive en Render: es la opción con menos piezas nuevas que pagar/mantener por separado.
- **GitHub Actions programado** (`schedule:` cron): gratis para repos con el uso típico de este proyecto, corre en un runner efímero (no necesita `pg_dump` instalado de forma permanente en ningún servidor propio).

Ninguna de las dos está provisionada. `backup.js`/`restore.js` están escritos para poder invocarse desde cualquiera de las dos sin cambios, el día que se decida.
