// src/routes/usuarios.js
// Gestión de cuentas y roles (Fase 4). No usa crudFactory porque el manejo
// de contraseñas es distinto (hay que hashear, y nunca se devuelve el hash).
// Sigue el mismo pipeline: auth() → requireEmpresa() → verificarPermiso('usuarios.xxx').
//
// Fase A (multi-tenant): la identidad (usuarios) es global, pero "ser
// usuario de esta empresa" y "qué rol tiene aquí" viven en usuario_empresa.
// Por eso esta pantalla ya no lee/escribe usuarios.rol/rol_id directo --
// opera sobre la membresía scoped a req.usuario.empresa_id.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { passwordCumplePolitica, MENSAJE_POLITICA_PASSWORD } from '../passwordPolicy.js';
import { registrarAuditoria } from '../registroAuditoria.js';

const router = Router();
router.use(auth, requireEmpresa);

// GET /api/usuarios/roles -> lista de roles con sus permisos (para el
// formulario "Nuevo usuario" y para una futura pantalla de "editar rol").
// roles/permisos son globales (misma lista para todas las empresas), no
// necesita scoping.
router.get('/roles', verificarPermiso('usuarios.ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.nombre,
              COALESCE(array_agg(p.nombre) FILTER (WHERE p.nombre IS NOT NULL), '{}') AS permisos
       FROM roles r
       LEFT JOIN rol_permiso rp ON rp.rol_id = r.id
       LEFT JOIN permisos p ON p.id = rp.permiso_id
       GROUP BY r.id, r.nombre
       ORDER BY r.id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los roles.' });
  }
});

// GET /api/usuarios -- solo los miembros de la empresa activa.
router.get('/', verificarPermiso('usuarios.ver'), async (req, res) => {
  try {
    // Sub-fase D: sucursal_id/sucursal_nombre para que la pantalla de
    // Usuarios pueda mostrar a qué sucursal está restringido cada uno (o
    // "todas" si es null) -- LEFT JOIN porque la mayoría va a seguir sin
    // restricción, no tiene por qué tener fila de sucursal.
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, u.email, r.nombre AS rol, ue.activo, ue.sucursal_id, s.nombre AS sucursal_nombre, u.creado_el,
              (u.totp_activado_el IS NOT NULL) AS tiene_2fa
       FROM usuario_empresa ue
       JOIN usuarios u ON u.id = ue.usuario_id
       JOIN roles r ON r.id = ue.rol_id
       LEFT JOIN sucursales s ON s.id = ue.sucursal_id
       WHERE ue.empresa_id = $1
       ORDER BY u.nombre`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los usuarios.' });
  }
});

// POST /api/usuarios  { nombre, email, password, rol }
// Si el email ya tiene cuenta (en esta empresa o en otra), se rechaza en vez
// de vincularlo en silencio -- sin un flujo de invitación por correo (fuera
// de alcance de Fase A), auto-vincular dejaría que el admin de una empresa
// "adopte" sin consentimiento la cuenta de alguien que ya trabaja en otra.
router.post('/', verificarPermiso('usuarios.crear'), async (req, res) => {
  const { nombre, email, password, rol } = req.body || {};
  if (!nombre || !email || !password || !rol) {
    return res.status(400).json({ error: 'Nombre, email, contraseña y rol son requeridos.' });
  }
  // Nadie puede crear una cuenta con rol "administrador" salvo alguien que ya
  // es administrador -- sin este check, cualquier rol con usuarios.crear
  // (por bug o por una futura mala configuración de permisos) podría crear
  // una cuenta nueva ya con el máximo privilegio.
  if (rol === 'administrador' && req.usuario.rol !== 'administrador') {
    return res.status(403).json({ error: 'Solo un administrador puede crear una cuenta con rol de administrador.' });
  }
  // Misma política que la recuperación de contraseña (ver
  // src/passwordPolicy.js) -- antes esta ruta solo exigía 6 caracteres,
  // unificado a pedido explícito para que alta y recuperación pidan lo mismo.
  if (!passwordCumplePolitica(password)) return res.status(400).json({ error: MENSAJE_POLITICA_PASSWORD });

  try {
    // Estas dos validaciones no dependen del límite de usuarios ni de
    // ningún lock -- se quedan afuera de la transacción, sin motivo para
    // serializarlas.
    const { rows: existente } = await pool.query('SELECT id FROM usuarios WHERE lower(email) = lower($1)', [email]);
    if (existente.length) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Pídele a esa persona que te comparta acceso, o contacta soporte para vincularla a tu empresa.' });
    }

    const { rows: rolRows } = await pool.query('SELECT id FROM roles WHERE nombre = $1', [rol]);
    if (!rolRows.length) return res.status(400).json({ error: `El rol "${rol}" no existe.` });

    const hash = await bcrypt.hash(password, 10);
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');

      // Nivel 1 (Urgente) del roadmap competitivo: el límite de usuarios
      // del plan, aplicado de verdad -- antes ningún plan lo hacía cumplir.
      // FOR UPDATE bloquea la fila de la empresa hasta el COMMIT/ROLLBACK,
      // mismo patrón que ya usa ventas.js para el stock -- sin esto, dos
      // invitaciones simultáneas justo en el límite podrían pasar la
      // validación LAS DOS antes de que cualquiera de las dos insertara,
      // superando el límite (hallazgo real de la revisión antes de
      // commitear, no un caso hipotético). Cuenta solo membresías ACTIVAS:
      // desactivar a alguien libera un cupo para invitar a otra persona,
      // sin tener que borrar la cuenta. Sin plan asignado, o con
      // limite_usuarios NULL (Profesional/Empresarial hoy) = sin límite,
      // mismo comportamiento que antes de esta migración.
      const { rows: empresaRows } = await cliente.query(
        `SELECT plan_id FROM empresas WHERE id = $1 FOR UPDATE`,
        [req.usuario.empresa_id]
      );
      const planId = empresaRows[0]?.plan_id;
      if (planId) {
        const { rows: planRows } = await cliente.query('SELECT limite_usuarios FROM planes WHERE id = $1', [planId]);
        const limiteUsuarios = planRows[0]?.limite_usuarios;
        if (limiteUsuarios !== null && limiteUsuarios !== undefined) {
          const { rows: countRows } = await cliente.query(
            `SELECT count(*)::int AS total FROM usuario_empresa WHERE empresa_id = $1 AND activo = true`,
            [req.usuario.empresa_id]
          );
          if (countRows[0].total >= limiteUsuarios) {
            await cliente.query('ROLLBACK');
            return res.status(403).json({
              error: `Tu empresa alcanzó el límite de ${limiteUsuarios} usuario(s) de su plan actual.`
            });
          }
        }
      }

      const { rows: nuevoUsuario } = await cliente.query(
        `INSERT INTO usuarios (nombre, email, password_hash) VALUES ($1, $2, $3) RETURNING id, nombre, email`,
        [nombre, email, hash]
      );
      await cliente.query(
        `INSERT INTO usuario_empresa (usuario_id, empresa_id, rol_id) VALUES ($1, $2, $3)`,
        [nuevoUsuario[0].id, req.usuario.empresa_id, rolRows[0].id]
      );
      await cliente.query('COMMIT');
      res.status(201).json({ ...nuevoUsuario[0], rol, activo: true });
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw err;
    } finally {
      cliente.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese email.' });
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear el usuario.' });
  }
});

// PUT /api/usuarios/:id  { nombre?, rol?, activo? }
// :id es el id de usuarios (identidad global). rol/activo se editan en la
// membresía (usuario_empresa) scoped a la empresa activa -- así un admin de
// la empresa A no puede tocar el rol que esa persona tiene en la empresa B.
// nombre sigue siendo un campo global de la identidad (mismo nombre se ve
// en todas las empresas donde participa esa persona) -- trade-off aceptado
// para Fase A.
router.put('/:id', verificarPermiso('usuarios.editar'), async (req, res) => {
  const { nombre, rol, activo } = req.body || {};
  const empresaId = req.usuario.empresa_id;
  const idObjetivo = Number(req.params.id);

  // Sub-fase D: mismo patrón "provisto" que plan_id en superadmin.js -- un
  // PUT que no manda sucursal_id no debe tocarla; uno que la manda null
  // debe poder "quitar" la restricción (vuelve a ver todas las sucursales).
  // COALESCE no alcanza para distinguir "no vino" de "vino vacío a propósito".
  const sucursalProvista = Object.prototype.hasOwnProperty.call(req.body || {}, 'sucursal_id');
  const sucursalIdBody = req.body?.sucursal_id;
  if (sucursalProvista && sucursalIdBody !== null && sucursalIdBody !== undefined && !Number.isInteger(sucursalIdBody)) {
    return res.status(400).json({ error: 'sucursal_id debe ser un número entero, o null para quitar la restricción.' });
  }

  if (rol) {
    // Nadie cambia su propio rol -- es una acción que otra persona toma
    // sobre vos, nunca vos mismo (mismo criterio que el auto-borrado del
    // DELETE de abajo). Va primero porque es la regla más fundamental: da
    // igual a qué rol se quiera cambiar, la respuesta es siempre la misma.
    // Esto es lo que de verdad cierra la escalación de privilegios: aunque
    // alguien tuviera usuarios.editar de más por error, no podría usarlo
    // sobre su propia cuenta.
    if (idObjetivo === req.usuario.id) {
      return res.status(400).json({ error: 'No podés cambiar tu propio rol.' });
    }
    // Mismo candado que en el POST: nadie asigna "administrador" salvo
    // alguien que ya lo es.
    if (rol === 'administrador' && req.usuario.rol !== 'administrador') {
      return res.status(403).json({ error: 'Solo un administrador puede asignar el rol de administrador.' });
    }
  }

  try {
    let rolId = null;
    if (rol) {
      const { rows: rolRows } = await pool.query('SELECT id FROM roles WHERE nombre = $1', [rol]);
      if (!rolRows.length) return res.status(400).json({ error: `El rol "${rol}" no existe.` });
      rolId = rolRows[0].id;
    }

    // Sub-fase D: 404 (no 400) si la sucursal indicada no existe o es de
    // otra empresa -- mismo criterio de "no confirmar existencia ajena" que
    // el resto del proyecto.
    if (sucursalProvista && sucursalIdBody !== null && sucursalIdBody !== undefined) {
      const { rows: sucursalRows } = await pool.query('SELECT id FROM sucursales WHERE id = $1 AND empresa_id = $2', [sucursalIdBody, empresaId]);
      if (!sucursalRows.length) return res.status(404).json({ error: 'La sucursal indicada no existe.' });
    }

    const { rows: membresia } = await pool.query(
      `UPDATE usuario_empresa SET
         rol_id = COALESCE($1, rol_id),
         activo = COALESCE($2, activo),
         sucursal_id = CASE WHEN $5 THEN $6 ELSE sucursal_id END
       WHERE usuario_id = $3 AND empresa_id = $4
       RETURNING usuario_id, rol_id, activo, sucursal_id`,
      [rolId, activo === undefined ? null : activo, req.params.id, empresaId, sucursalProvista, sucursalIdBody ?? null]
    );
    if (!membresia.length) return res.status(404).json({ error: 'Usuario no encontrado en esta empresa.' });

    if (nombre) {
      await pool.query(`UPDATE usuarios SET nombre = $1, actualizado_el = now() WHERE id = $2`, [nombre, req.params.id]);
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, u.email, r.nombre AS rol, ue.activo, ue.sucursal_id, s.nombre AS sucursal_nombre
       FROM usuario_empresa ue
       LEFT JOIN sucursales s ON s.id = ue.sucursal_id
       JOIN usuarios u ON u.id = ue.usuario_id
       JOIN roles r ON r.id = ue.rol_id
       WHERE ue.usuario_id = $1 AND ue.empresa_id = $2`,
      [req.params.id, empresaId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar el usuario.' });
  }
});

// POST /api/usuarios/:id/reset-2fa
// Para quien perdió el celular Y sus códigos de recuperación: apaga el 2FA de
// esa persona (podrá volver a activarlo desde Seguridad). Es una decisión de
// quien administra la empresa, así que va con usuarios.editar y queda en
// Auditoría. Como el 2FA es de la identidad (global), esto también lo apaga en
// otras empresas donde participe -- mismo trade-off que ya documenta el PUT de
// arriba para `nombre`; la persona sigue necesitando su contraseña para entrar.
router.post('/:id/reset-2fa', verificarPermiso('usuarios.editar'), async (req, res) => {
  const idObjetivo = Number(req.params.id);
  if (!Number.isInteger(idObjetivo)) return res.status(400).json({ error: 'id inválido.' });
  // Nadie se restablece a sí mismo: para eso está "Desactivar" en Seguridad,
  // que pide contraseña y un código (esto, en cambio, no pide nada de la persona).
  if (idObjetivo === req.usuario.id) {
    return res.status(400).json({ error: 'Para desactivar tu propia verificación en dos pasos usa la pantalla de Seguridad.' });
  }

  try {
    const { rows: membresia } = await pool.query(
      `SELECT r.nombre AS rol
       FROM usuario_empresa ue JOIN roles r ON r.id = ue.rol_id
       WHERE ue.usuario_id = $1 AND ue.empresa_id = $2`,
      [idObjetivo, req.usuario.empresa_id]
    );
    if (!membresia.length) return res.status(404).json({ error: 'Usuario no encontrado en esta empresa.' });
    // Mismo candado que asignar el rol: a un administrador solo lo toca otro administrador.
    if (membresia[0].rol === 'administrador' && req.usuario.rol !== 'administrador') {
      return res.status(403).json({ error: 'Solo un administrador puede restablecer el 2FA de otro administrador.' });
    }

    const cliente = await pool.connect();
    let teniaActivo;
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query(
        `UPDATE usuarios u SET totp_secreto_cifrado = NULL, totp_activado_el = NULL, totp_ultimo_paso = NULL
         FROM (SELECT id, totp_activado_el IS NOT NULL AS activo FROM usuarios WHERE id = $1 FOR UPDATE) previo
         WHERE u.id = previo.id
         RETURNING previo.activo`,
        [idObjetivo]
      );
      teniaActivo = rows[0]?.activo === true;
      await cliente.query('DELETE FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [idObjetivo]);
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }

    res.json({ ok: true, teniaActivo });
    if (teniaActivo) {
      registrarAuditoria(pool, { usuario: req.usuario, accion: 'reset_2fa', modulo: 'usuarios', registroId: idObjetivo, detalle: null });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo restablecer el 2FA.' });
  }
});

// DELETE /api/usuarios/:id
// Igual que PUT, esto quita la MEMBRESÍA a la empresa activa
// (usuario_empresa), no borra la identidad global (usuarios) -- una persona
// puede pertenecer a otras empresas, y esta ruta scoped a empresa_id no
// tiene forma de saber si es seguro borrar esas otras membresías. Si esta
// era su única empresa, la cuenta simplemente queda sin acceso a ninguna
// (no puede volver a loguearse en ningún lado), pero la fila en `usuarios`
// se queda -- limpiar identidades huérfanas queda fuera de alcance.
router.delete('/:id', verificarPermiso('usuarios.eliminar'), async (req, res) => {
  const idObjetivo = Number(req.params.id);
  if (idObjetivo === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo.' });
  }

  try {
    const { rows } = await pool.query(
      `DELETE FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2 RETURNING usuario_id`,
      [idObjetivo, req.usuario.empresa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado en esta empresa.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo eliminar el usuario.' });
  }
});

export default router;
