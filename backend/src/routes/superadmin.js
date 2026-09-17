// src/routes/superadmin.js
// Panel de super administrador: gestiona empresas, sus módulos habilitados,
// y su primer administrador -- reemplaza los scripts SQL manuales que se
// venían usando para dar de alta cada empresa nueva. Protegido por
// requireSuperAdmin() en vez de requireEmpresa(): estas rutas cruzan
// empresas a propósito, así que no hay (ni debe haber) scoping por
// empresa_id en ninguna consulta de este archivo.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { auth, requireSuperAdmin } from '../middleware/auth.js';
import { registrarAuditoria, registrarAuditoriaPlataforma } from '../registroAuditoria.js';

const router = Router();
router.use(auth, requireSuperAdmin);

router.get('/empresas', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        (SELECT count(*) FROM usuario_empresa ue WHERE ue.empresa_id = e.id) AS usuarios_count,
        (SELECT count(*) FROM empresa_modulos em WHERE em.empresa_id = e.id) AS modulos_count
      FROM empresas e
      ORDER BY e.nombre
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las empresas.' });
  }
});

router.post('/empresas', async (req, res) => {
  const { nombre, logo } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido.' });
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO empresas (nombre, logo) VALUES ($1, $2) RETURNING *`,
      [String(nombre).trim(), logo || null]
    );
    // Sub-fase B (sucursales): inventario.js ya exige sucursal_id en cada
    // producto nuevo, así que ninguna empresa puede arrancar sin al menos
    // una -- mismo rol que cumplió el backfill de la migración 036 para las
    // empresas que ya existían, pero ahora en el momento de creación, para
    // las que se den de alta de acá en adelante.
    await cliente.query(
      `INSERT INTO sucursales (empresa_id, nombre, principal) VALUES ($1, 'Sucursal Principal', true)`,
      [rows[0].id]
    );
    await cliente.query('COMMIT');
    res.status(201).json(rows[0]);
    // empresa_id acá es la recién creada -- es lo único que la hace
    // auditable en audit_log (empresa_id es NOT NULL, ver 012_empresas.sql).
    // req.usuario NO trae empresa_id en una sesión real de super admin, por
    // eso se arma el objeto a mano en vez de pasar req.usuario tal cual.
    registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: rows[0].id },
      accion: 'crear', modulo: 'superadmin', registroId: rows[0].id,
      detalle: { nombre: rows[0].nombre }
    });
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear la empresa.' });
  } finally {
    cliente.release();
  }
});

// color_primario: null/'' = "quitar personalización, volver al color de
// GEALMI por defecto". A diferencia de nombre/logo/activo, un PUT que
// no lo manda debe DEJARLO IGUAL (no borrarlo) -- COALESCE no alcanza para
// eso, porque no distingue "no vino en el body" de "vino vacío a propósito
// para borrarlo"; ambos casos necesitan comportamiento distinto acá. Por
// eso se manda un flag aparte (colorProvisto) y un CASE en el UPDATE. Se
// valida el formato hex porque el frontend lo inyecta directo como valor
// de una propiedad CSS (ver aplicarTema() en js/config.js).
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

router.put('/empresas/:id', async (req, res) => {
  const { nombre, logo, activo } = req.body || {};
  const colorProvisto = Object.prototype.hasOwnProperty.call(req.body || {}, 'color_primario');
  const colorPrimario = req.body?.color_primario;
  if (colorPrimario && !HEX_COLOR.test(colorPrimario)) {
    return res.status(400).json({ error: 'color_primario debe ser un color hex válido, ej. #E3B23C.' });
  }
  // plan_id: mismo criterio que color_primario -- un PUT que no lo manda
  // debe dejarlo igual, uno que lo manda null debe poder "desasignar" el
  // plan (vuelve a limite_usuarios ilimitado, ver POST /api/usuarios).
  const planProvisto = Object.prototype.hasOwnProperty.call(req.body || {}, 'plan_id');
  const planId = req.body?.plan_id;
  // Validación de FORMATO (síncrona, sin tocar la base) antes del try: un
  // plan_id que no es ni numérico ni null/undefined nunca puede existir en
  // la tabla, así que se rechaza acá sin gastar una query -- y sobre todo,
  // sin mandar un valor no numérico a Postgres (ver nota de abajo).
  if (planProvisto && planId !== null && planId !== undefined && !Number.isInteger(planId)) {
    return res.status(400).json({ error: 'plan_id debe ser un número entero, o null para quitar el plan.' });
  }
  try {
    // La validación de EXISTENCIA (si el id numérico corresponde a un plan
    // real) va DENTRO del try -- hallazgo de la revisión: antes esta query
    // vivía afuera del try/catch. Un plan_id que Postgres rechazara por
    // tipo (ej. un objeto/array que igual pasara la guarda de arriba)
    // habría quedado como una promesa rechazada sin capturar en un handler
    // async de Express 4 (que no las atrapa solo) -- y sin ningún
    // process.on('unhandledRejection', ...) en server.js, Node tumba el
    // proceso ENTERO por default, no solo esta request.
    if (planProvisto && planId !== null && planId !== undefined) {
      const { rows: planRows } = await pool.query('SELECT id FROM planes WHERE id = $1', [planId]);
      if (!planRows.length) return res.status(400).json({ error: `El plan #${planId} no existe.` });
    }

    // Leída ANTES de pisarla -- es la única forma de saber después qué
    // cambió de verdad (mismo criterio que crudFactory.js). Sin datos
    // sensibles en esta tabla (empresas no tiene hashes/tokens).
    const { rows: antesRows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [req.params.id]);
    if (!antesRows.length) return res.status(404).json({ error: 'Empresa no encontrada.' });
    const antes = antesRows[0];

    const { rows } = await pool.query(
      `UPDATE empresas SET
         nombre = COALESCE($1, nombre),
         logo = COALESCE($2, logo),
         activo = COALESCE($3, activo),
         color_primario = CASE WHEN $4 THEN $5 ELSE color_primario END,
         plan_id = CASE WHEN $7 THEN $8 ELSE plan_id END,
         actualizado_el = now()
       WHERE id = $6
       RETURNING *`,
      [nombre || null, logo || null, activo === undefined ? null : activo, colorProvisto, colorPrimario || null, req.params.id, planProvisto, planId ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada.' });
    res.json(rows[0]);

    const despues = rows[0];
    const cambios = {};
    ['nombre', 'logo', 'activo', 'color_primario', 'plan_id'].forEach(campo => {
      if (String(antes[campo] ?? '') !== String(despues[campo] ?? '')) {
        cambios[campo] = { antes: antes[campo], despues: despues[campo] };
      }
    });
    registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: req.params.id },
      accion: 'editar', modulo: 'superadmin', registroId: req.params.id,
      detalle: Object.keys(cambios).length ? cambios : 'Sin cambios en los valores (se guardó igual).'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la empresa.' });
  }
});

// Catálogo de planes (para el selector de "asignar plan" en el panel de
// empresas). Sin escritura todavía -- los 3 planes se siembran en la
// migración 035; editarlos por API queda para cuando exista el sistema
// completo de Contratación/Suscripciones.
router.get('/planes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM planes ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los planes.' });
  }
});

// Catálogo completo de módulos (para armar la lista de checkboxes en el frontend).
router.get('/modulos', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM modulos ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los módulos.' });
  }
});

// id: mismo formato que ya usa el catálogo (ver 012_empresas.sql) -- string
// corto en snake_case, porque además de PK es el prefijo de permisos
// ("<id>.ver", "<id>.crear"...) y el data-modulo del frontend.
const ID_MODULO = /^[a-z][a-z0-9_]{1,39}$/;

// Dar de alta un módulo NUEVO en el catálogo -- lo que antes solo se podía
// hacer escribiendo una migración SQL (ver 012/014/019/020/021/022). Esto
// resuelve la mitad "catálogo" del problema: el módulo ya aparece como
// checkbox para habilitarlo por empresa. La otra mitad -- la tabla SQL real
// y las rutas Express si el módulo necesita persistencia propia
// (base_de_datos:true) -- sigue siendo trabajo de código; un módulo creado
// acá sin esa implementación queda como una página sin backend real detrás
// (mismo estado que Marketing hoy, que es deliberadamente CSV-only).
router.post('/modulos', async (req, res) => {
  const { id, label, icon, page, base_de_datos, dependencias } = req.body || {};
  if (!id || !ID_MODULO.test(id)) {
    return res.status(400).json({ error: 'id es requerido: minúsculas, números y guion bajo, 2-40 caracteres, debe empezar con letra.' });
  }
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label es requerido.' });
  if (!page || !String(page).trim()) return res.status(400).json({ error: 'page es requerido (ej. "mascotas.html").' });

  const deps = Array.isArray(dependencias) ? dependencias : [];
  try {
    if (deps.length) {
      const { rows: existentes } = await pool.query(`SELECT id FROM modulos WHERE id = ANY($1::varchar[])`, [deps]);
      const faltantes = deps.filter(d => !existentes.some(e => e.id === d));
      if (faltantes.length) {
        return res.status(400).json({ error: `Estas dependencias no existen en el catálogo: ${faltantes.join(', ')}.` });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO modulos (id, label, icon, page, base_de_datos, dependencias)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, String(label).trim(), icon || null, String(page).trim(), !!base_de_datos, deps]
    );
    res.status(201).json(rows[0]);
    registrarAuditoriaPlataforma(pool, {
      usuario: req.usuario, accion: 'crear', entidad: 'modulo', entidadId: rows[0].id,
      detalle: { label: rows[0].label, page: rows[0].page }
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Ya existe un módulo con id "${id}".` });
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear el módulo.' });
  }
});

// El id NO se puede editar acá a propósito: es la PK que ya referencian
// empresa_modulos, permisos ("<id>.ver"...) y las dependencias de otros
// módulos -- cambiarlo en caliente los dejaría a todos apuntando a un id
// que ya no existe. Si un id quedó mal, se borra (si nadie lo usa todavía)
// y se crea de nuevo.
router.put('/modulos/:id', async (req, res) => {
  const { label, icon, page, base_de_datos, dependencias } = req.body || {};
  const deps = dependencias === undefined ? undefined : (Array.isArray(dependencias) ? dependencias : []);
  try {
    if (deps && deps.includes(req.params.id)) {
      return res.status(400).json({ error: 'Un módulo no puede depender de sí mismo.' });
    }
    if (deps && deps.length) {
      const { rows: existentes } = await pool.query(`SELECT id FROM modulos WHERE id = ANY($1::varchar[])`, [deps]);
      const faltantes = deps.filter(d => !existentes.some(e => e.id === d));
      if (faltantes.length) {
        return res.status(400).json({ error: `Estas dependencias no existen en el catálogo: ${faltantes.join(', ')}.` });
      }
    }
    // Leído ANTES de pisarlo -- es la única forma de saber después qué
    // cambió de verdad (mismo criterio que crudFactory.js / PUT /empresas/:id).
    const { rows: antesRows } = await pool.query('SELECT * FROM modulos WHERE id = $1', [req.params.id]);
    if (!antesRows.length) return res.status(404).json({ error: 'Ese módulo no existe en el catálogo.' });
    const antes = antesRows[0];

    const { rows } = await pool.query(
      `UPDATE modulos SET
         label = COALESCE($1, label),
         icon = COALESCE($2, icon),
         page = COALESCE($3, page),
         base_de_datos = COALESCE($4, base_de_datos),
         dependencias = COALESCE($5, dependencias)
       WHERE id = $6
       RETURNING *`,
      [label ? String(label).trim() : null, icon || null, page ? String(page).trim() : null,
       base_de_datos === undefined ? null : !!base_de_datos, deps, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ese módulo no existe en el catálogo.' });
    res.json(rows[0]);

    const despues = rows[0];
    const cambios = {};
    ['label', 'icon', 'page', 'base_de_datos'].forEach(campo => {
      if (String(antes[campo] ?? '') !== String(despues[campo] ?? '')) {
        cambios[campo] = { antes: antes[campo], despues: despues[campo] };
      }
    });
    // dependencias es un arreglo -- comparación aparte, String() no alcanza.
    if (JSON.stringify(antes.dependencias ?? []) !== JSON.stringify(despues.dependencias ?? [])) {
      cambios.dependencias = { antes: antes.dependencias, despues: despues.dependencias };
    }
    registrarAuditoriaPlataforma(pool, {
      usuario: req.usuario, accion: 'editar', entidad: 'modulo', entidadId: req.params.id,
      detalle: Object.keys(cambios).length ? cambios : 'Sin cambios en los valores (se guardó igual).'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar el módulo.' });
  }
});

// Borrar del catálogo, no solo desactivar -- por eso las dos comprobaciones:
// ninguna empresa debe quedarse con un módulo fantasma activo, y ningún
// otro módulo debe quedar con una dependencia que ya no existe.
router.delete('/modulos/:id', async (req, res) => {
  try {
    const { rows: enUso } = await pool.query(
      `SELECT count(*)::int AS n FROM empresa_modulos WHERE modulo_id = $1`, [req.params.id]
    );
    if (enUso[0].n > 0) {
      return res.status(400).json({ error: `No se puede borrar: ${enUso[0].n} empresa(s) todavía lo tienen activo.` });
    }
    const { rows: dependientes } = await pool.query(
      `SELECT id FROM modulos WHERE $1 = ANY(dependencias)`, [req.params.id]
    );
    if (dependientes.length) {
      return res.status(400).json({ error: `No se puede borrar: lo necesitan ${dependientes.map(d => d.id).join(', ')}.` });
    }
    // "Foto" de lo que se va a borrar -- una vez eliminado, es la única
    // forma de saber después qué era (mismo criterio que mascotas.js/
    // inventario.js en sus DELETE).
    const { rows: existente } = await pool.query('SELECT label, page FROM modulos WHERE id = $1', [req.params.id]);
    const { rowCount } = await pool.query(`DELETE FROM modulos WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Ese módulo no existe en el catálogo.' });
    res.status(204).end();
    registrarAuditoriaPlataforma(pool, {
      usuario: req.usuario, accion: 'eliminar', entidad: 'modulo', entidadId: req.params.id,
      detalle: { eliminado: existente[0] }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo borrar el módulo.' });
  }
});

// Catálogo + qué está habilitado para ESA empresa puntual.
router.get('/empresas/:id/modulos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.label, m.icon, m.base_de_datos, m.dependencias, (em.modulo_id IS NOT NULL) AS habilitado
       FROM modulos m
       LEFT JOIN empresa_modulos em ON em.modulo_id = m.id AND em.empresa_id = $1
       ORDER BY m.id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los módulos de la empresa.' });
  }
});

router.post('/empresas/:id/modulos', async (req, res) => {
  const { modulo_id } = req.body || {};
  if (!modulo_id) return res.status(400).json({ error: 'modulo_id es requerido.' });
  try {
    // No se puede activar un módulo cuyas dependencias todavía no están
    // activas para esta empresa (ej. Postventa sin Vehículos: el selector
    // de vehículo del formulario saldría vacío). Ver 023_dependencias_modulos.sql
    // -- solo las relaciones que son de verdad obligatorias en el esquema
    // están listadas acá; el resto se dejó opcional a propósito.
    const { rows: moduloRows } = await pool.query(`SELECT dependencias FROM modulos WHERE id = $1`, [modulo_id]);
    if (!moduloRows.length) return res.status(404).json({ error: `El módulo "${modulo_id}" no existe.` });
    const dependencias = moduloRows[0].dependencias || [];
    if (dependencias.length) {
      const { rows: activos } = await pool.query(
        `SELECT modulo_id FROM empresa_modulos WHERE empresa_id = $1 AND modulo_id = ANY($2::varchar[])`,
        [req.params.id, dependencias]
      );
      const faltantes = dependencias.filter(d => !activos.some(a => a.modulo_id === d));
      if (faltantes.length) {
        return res.status(400).json({
          error: `Antes de activar "${modulo_id}" hay que activar: ${faltantes.join(', ')}.`
        });
      }
    }
    await pool.query(
      `INSERT INTO empresa_modulos (empresa_id, modulo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, modulo_id]
    );
    res.status(201).json({ ok: true });
    registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: req.params.id },
      accion: 'crear', modulo: 'superadmin', registroId: req.params.id,
      detalle: { moduloActivado: modulo_id }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo habilitar el módulo.' });
  }
});

router.delete('/empresas/:id/modulos/:moduloId', async (req, res) => {
  try {
    // Simétrico al POST: no se puede apagar un módulo mientras otro que
    // depende de él siga activo para esta empresa (dejaría, por ejemplo,
    // Postventa activo sin Vehículos).
    const { rows: dependientes } = await pool.query(
      `SELECT m.id FROM modulos m
       JOIN empresa_modulos em ON em.modulo_id = m.id AND em.empresa_id = $1
       WHERE $2 = ANY(m.dependencias)`,
      [req.params.id, req.params.moduloId]
    );
    if (dependientes.length) {
      return res.status(400).json({
        error: `No se puede desactivar "${req.params.moduloId}": lo necesitan ${dependientes.map(d => d.id).join(', ')}.`
      });
    }
    await pool.query(
      `DELETE FROM empresa_modulos WHERE empresa_id = $1 AND modulo_id = $2`,
      [req.params.id, req.params.moduloId]
    );
    res.status(204).end();
    registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: req.params.id },
      accion: 'eliminar', modulo: 'superadmin', registroId: req.params.id,
      detalle: { moduloDesactivado: req.params.moduloId }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo deshabilitar el módulo.' });
  }
});

// Crea (o reusa, si el email ya tiene cuenta globalmente) un usuario y lo
// vincula como administrador de esta empresa -- mismo flujo que
// seedAdmin.js, ahora disponible sin terminal. A diferencia de
// routes/usuarios.js (que rechaza un email ya existente para no vincular
// sin consentimiento a alguien fuera de contexto), aquí SÍ se reusa a
// propósito: es el super admin quien está pidiendo explícitamente "agrega
// a esta persona como admin de esta empresa", no un efecto secundario
// ambiguo de un formulario de alta común.
router.post('/empresas/:id/admin', async (req, res) => {
  const { nombre, email, password } = req.body || {};
  if (!nombre || !email) return res.status(400).json({ error: 'nombre y email son requeridos.' });

  try {
    const { rows: rolAdmin } = await pool.query(`SELECT id FROM roles WHERE nombre = 'administrador'`);
    if (!rolAdmin.length) return res.status(500).json({ error: 'No existe el rol administrador (¿corriste las migraciones?).' });

    const { rows: existentes } = await pool.query(`SELECT id FROM usuarios WHERE lower(email) = lower($1)`, [email]);
    let usuarioId;
    if (existentes.length) {
      usuarioId = existentes[0].id;
    } else {
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'password es requerido (mínimo 6 caracteres) para crear una cuenta nueva.' });
      }
      const hash = await bcrypt.hash(password, 10);
      const { rows: nuevo } = await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [nombre, email, hash]
      );
      usuarioId = nuevo[0].id;
    }

    const { rows } = await pool.query(
      `INSERT INTO usuario_empresa (usuario_id, empresa_id, rol_id) VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id, empresa_id) DO UPDATE SET rol_id = EXCLUDED.rol_id, activo = true
       RETURNING usuario_id, empresa_id`,
      [usuarioId, req.params.id, rolAdmin[0].id]
    );
    res.status(201).json(rows[0]);
    // Nunca password/hash en detalle -- solo el email (identificador
    // funcional) y si la cuenta ya existía o se creó de cero.
    registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: req.params.id },
      accion: 'crear', modulo: 'superadmin', registroId: req.params.id,
      detalle: { adminEmail: email, cuentaReutilizada: existentes.length > 0 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear el administrador de la empresa.' });
  }
});

// Borra la empresa DE VERDAD -- no es reversible, a diferencia de PUT
// .../empresas/:id con activo:false (que solo bloquea el login y se puede
// revertir en cualquier momento). Arrastra en cascada TODOS sus datos:
// ventas, inventario, clientes, cada módulo activo (ver
// 031_eliminar_empresa_cascade.sql). Por eso exige escribir el nombre EXACTO
// de la empresa en confirmarNombre -- así no es posible borrar por error con
// una llamada apurada a la API, ni con un solo clic distraído en el panel.
router.delete('/empresas/:id', async (req, res) => {
  const confirmarNombre = String(req.body?.confirmarNombre || '').trim();
  const cliente = await pool.connect();
  try {
    const { rows } = await cliente.query(`SELECT id, nombre FROM empresas WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada.' });
    const empresa = rows[0];

    if (confirmarNombre !== empresa.nombre) {
      return res.status(400).json({ error: 'El nombre no coincide. Escribe el nombre exacto de la empresa para confirmar.' });
    }

    await cliente.query('BEGIN');
    // Se audita ANTES del DELETE, no después: audit_log.empresa_id pasa a
    // NULL por el ON DELETE SET NULL de esa tabla, así que esta fila
    // sobrevive al borrado -- a propósito, queda como el único rastro de que
    // esta empresa existió alguna vez.
    await registrarAuditoria(cliente, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: empresa.id },
      accion: 'eliminar', modulo: 'superadmin', registroId: empresa.id, detalle: { nombre: empresa.nombre }
    });
    await cliente.query(`DELETE FROM empresas WHERE id = $1`, [empresa.id]);
    await cliente.query('COMMIT');

    res.status(204).end();
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo borrar la empresa.' });
  } finally {
    cliente.release();
  }
});

// Vida corta (30 min, contra las 8h de una sesión normal) porque esto es
// acceso de soporte, no una sesión de trabajo -- si hace falta más tiempo,
// se vuelve a pedir.
const DURACION_IMPERSONACION = '30m';

// "Entrar como soporte" a una empresa sin necesitar la contraseña de nadie
// de ahí. Identidad propia (ver 028_impersonacion.sql, charla de diseño
// aparte): el JWT lleva el id/nombre REALES del super admin -- nunca toma
// prestada la identidad de un admin de la empresa -- más un rol de
// administrador sintetizado para esa empresa puntual (no depende de que
// exista una fila en usuario_empresa) y el flag impersonando:true. Ese flag
// es lo único que hace falta para que registrarAuditoria() marque
// automáticamente cada acción tomada durante esta sesión (ver
// registroAuditoria.js) -- ninguna otra ruta de escritura necesita saber
// que existe la impersonación.
router.post('/empresas/:id/impersonar', async (req, res) => {
  const motivo = (req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ error: 'Escribe un motivo antes de entrar como soporte.' });

  try {
    const { rows: empresaRows } = await pool.query(`SELECT * FROM empresas WHERE id = $1`, [req.params.id]);
    if (!empresaRows.length) return res.status(404).json({ error: 'Empresa no encontrada.' });
    const empresa = empresaRows[0];
    if (!empresa.activo) return res.status(400).json({ error: 'Esta empresa está desactivada.' });

    const { rows: permisosRows } = await pool.query(
      `SELECT COALESCE(array_agg(p.nombre) FILTER (WHERE p.nombre IS NOT NULL), '{}') AS permisos
       FROM roles r
       LEFT JOIN rol_permiso rp ON rp.rol_id = r.id
       LEFT JOIN permisos p ON p.id = rp.permiso_id
       WHERE r.nombre = 'administrador'
       GROUP BY r.nombre`
    );
    const permisos = permisosRows[0]?.permisos || [];

    const payload = {
      id: req.usuario.id,
      nombre: req.usuario.nombre,
      email: req.usuario.email,
      empresa_id: empresa.id,
      empresa_nombre: empresa.nombre,
      rol: 'administrador',
      permisos,
      impersonando: true,
      // Sub-fase D: soporte impersonando SIEMPRE sin restricción de
      // sucursal, explícito -- no tiene fila real en usuario_empresa (ver
      // nota arriba sobre por qué esta sesión ya se salta requireModulo del
      // mismo modo), así que no hay de dónde leer una sucursal asignada, y
      // aunque la hubiera, soporte necesita ver la empresa completa.
      sucursal_id: null
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: DURACION_IMPERSONACION });

    // Se audita bajo la empresa impersonada (no bajo "superadmin") a
    // propósito -- así aparece en la propia Auditoría de esa empresa, y sus
    // usuarios pueden ver que soporte entró, cuándo y por qué. Transparencia
    // hacia el cliente, no solo un log interno.
    await registrarAuditoria(pool, {
      usuario: { id: req.usuario.id, nombre: req.usuario.nombre, empresa_id: empresa.id },
      accion: 'impersonar',
      modulo: 'superadmin',
      registroId: empresa.id,
      detalle: { empresa: empresa.nombre, motivo }
    });

    res.json({ token, usuario: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar la sesión de soporte.' });
  }
});

export default router;
