// src/routes/cajas.js
// Sub-fase E (roadmap competitivo, Nivel 2): CRUD de cajas (terminales de
// cobro dentro de una sucursal) + el ciclo de vida de un turno
// (abrir -> operar -> cerrar con arqueo).
//
// SUPUESTO EXPLÍCITO DEL ARQUEO (documentado a pedido, ver migración 040 y
// la conversación de diseño): GEALMI HOY NO distingue medio de pago en
// el flujo genérico de ventas/finanzas (no hay columna medio_pago en
// ninguna de las dos -- lo único parecido es pagos_membresia del vertical
// Gimnasio, una tabla completamente aparte). El cálculo de monto_cierre_
// sistema de acá abajo asume que TODO lo registrado en finanzas durante un
// turno es efectivo. Si el negocio ya cobra con Yape/tarjeta/transferencia,
// la "diferencia" que devuelve el cierre no es necesariamente un faltante
// real de caja -- puede ser plata que nunca entró físicamente al cajón.
// Agregar medio_pago real a ventas.js queda anotado como sub-fase futura.
//
// El cálculo usa SOLO `finanzas` (no suma ventas.monto aparte) -- toda
// venta con turno_caja_id ya deja su ingreso correspondiente en finanzas
// con el mismo turno_caja_id (ver ventas.js POST); sumar las dos fuentes
// duplicaría cada venta.
//
// turno_caja_id es OPCIONAL y EXPLÍCITO en ventas.js/finanzas.js -- no
// existe (todavía) un concepto de "sesión de caja activa"; sin mandarlo,
// una venta o un movimiento de finanzas se comporta exactamente igual que
// antes de esta sub-fase (mismo criterio que ya se usó para sucursal_id).

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { resolverRestriccionSucursal } from '../middleware/sucursal.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';

const router = Router();
router.use(auth, requireEmpresa, resolverRestriccionSucursal);

function numeroOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- CRUD de cajas ----------

// GET /api/cajas?sucursal_id= -- opcional, mismo opt-in que en otros módulos.
router.get('/', verificarPermiso('cajas.ver'), async (req, res) => {
  const sucursalEfectiva = req.sucursalRestringida ?? req.query.sucursal_id;
  const valores = [req.usuario.empresa_id];
  const condiciones = ['empresa_id = $1'];
  if (sucursalEfectiva) { valores.push(sucursalEfectiva); condiciones.push(`sucursal_id = $${valores.length}`); }
  try {
    const { rows } = await pool.query(`SELECT * FROM cajas WHERE ${condiciones.join(' AND ')} ORDER BY nombre`, valores);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las cajas.' });
  }
});

// GET /api/cajas/turnos?caja_id=&sucursal_id=&estado= -- historial de
// turnos. Va ANTES de las rutas /:id a propósito, para que Express nunca
// confunda "turnos" con un :id de caja.
router.get('/turnos', verificarPermiso('cajas.ver'), async (req, res) => {
  const { caja_id, estado } = req.query;
  const sucursalEfectiva = req.sucursalRestringida ?? req.query.sucursal_id;
  const valores = [req.usuario.empresa_id];
  const condiciones = ['t.empresa_id = $1'];
  if (caja_id) { valores.push(caja_id); condiciones.push(`t.caja_id = $${valores.length}`); }
  if (estado) { valores.push(estado); condiciones.push(`t.estado = $${valores.length}`); }
  if (sucursalEfectiva) { valores.push(sucursalEfectiva); condiciones.push(`c.sucursal_id = $${valores.length}`); }
  try {
    // Sub-fase F: nombre de quién abrió/cerró, no solo el id -- para que el
    // historial del frontend no tenga que resolverlo aparte. LEFT JOIN
    // porque usuario_cierre_id es null mientras el turno sigue abierto (y,
    // desde la Sub-fase E, usuario_apertura_id también puede quedar null si
    // esa cuenta se borró -- ver migración 040, ON DELETE SET NULL).
    const { rows } = await pool.query(
      `SELECT t.*, c.nombre AS caja_nombre, c.sucursal_id,
              ua.nombre AS usuario_apertura_nombre, uc.nombre AS usuario_cierre_nombre
       FROM turnos_caja t
       JOIN cajas c ON c.id = t.caja_id
       LEFT JOIN usuarios ua ON ua.id = t.usuario_apertura_id
       LEFT JOIN usuarios uc ON uc.id = t.usuario_cierre_id
       WHERE ${condiciones.join(' AND ')}
       ORDER BY t.fecha_apertura DESC LIMIT 500`,
      valores
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer los turnos.' });
  }
});

// GET /api/cajas/turnos/:id -- detalle de un turno, con el "esperado en
// caja" calculado en vivo aunque siga abierto (útil para un preview antes
// de declarar el monto de cierre).
router.get('/turnos/:id', verificarPermiso('cajas.ver'), async (req, res) => {
  const restringido = req.sucursalRestringida != null;
  const condSucursal = restringido ? ' AND c.sucursal_id = $3' : '';
  const valores = restringido
    ? [req.params.id, req.usuario.empresa_id, req.sucursalRestringida]
    : [req.params.id, req.usuario.empresa_id];
  try {
    const { rows } = await pool.query(
      `SELECT t.*, c.nombre AS caja_nombre, c.sucursal_id,
              ua.nombre AS usuario_apertura_nombre, uc.nombre AS usuario_cierre_nombre
       FROM turnos_caja t
       JOIN cajas c ON c.id = t.caja_id
       LEFT JOIN usuarios ua ON ua.id = t.usuario_apertura_id
       LEFT JOIN usuarios uc ON uc.id = t.usuario_cierre_id
       WHERE t.id = $1 AND t.empresa_id = $2${condSucursal}`,
      valores
    );
    if (!rows.length) return res.status(404).json({ error: 'Turno no encontrado.' });
    const turno = rows[0];

    const { rows: netoRows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END), 0) AS egresos
       FROM finanzas WHERE turno_caja_id = $1 AND empresa_id = $2`,
      [turno.id, req.usuario.empresa_id]
    );
    const ingresos = Number(netoRows[0].ingresos);
    const egresos = Number(netoRows[0].egresos);
    const montoEsperado = +(Number(turno.monto_apertura) + ingresos - egresos).toFixed(2);

    res.json({ ...turno, ingresos_turno: ingresos, egresos_turno: egresos, monto_esperado: montoEsperado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo leer el turno.' });
  }
});

// POST /api/cajas -- { nombre, sucursal_id }
router.post('/', verificarPermiso('cajas.crear'), async (req, res) => {
  const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });

  // Mismo criterio que inventario.js POST: sin sucursal_id explícita, se
  // autocompleta con la del usuario restringido (si aplica). Un pedido
  // explícito de otra ya lo cortó resolverRestriccionSucursal con 403.
  const sucursalIdCruda = req.body?.sucursal_id ?? req.sucursalRestringida ?? undefined;
  const sucursalId = Number(sucursalIdCruda);
  if (!sucursalIdCruda || !Number.isInteger(sucursalId)) {
    return res.status(400).json({ error: 'sucursal_id es requerido y debe ser un número entero.' });
  }

  try {
    // 404 (no 400) si la sucursal no existe, es de otra empresa, o (Sub-fase
    // D) el usuario está restringido a otra -- defensa en profundidad,
    // misma query decide, no solo la lógica de la ruta.
    const { rows: sucursalRows } = await pool.query(
      `SELECT id FROM sucursales WHERE id = $1 AND empresa_id = $2 AND ($3::int IS NULL OR id = $3)`,
      [sucursalId, req.usuario.empresa_id, req.sucursalRestringida ?? null]
    );
    if (!sucursalRows.length) return res.status(404).json({ error: 'La sucursal indicada no existe.' });

    const { rows } = await pool.query(
      `INSERT INTO cajas (sucursal_id, empresa_id, nombre) VALUES ($1,$2,$3) RETURNING *`,
      [sucursalId, req.usuario.empresa_id, nombre]
    );
    res.status(201).json(rows[0]);
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'cajas', registroId: rows[0].id, detalle: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear la caja.' });
  }
});

// POST /api/cajas/:id/turnos -- abrir turno. { monto_apertura }
router.post('/:id/turnos', verificarPermiso('cajas.editar'), async (req, res) => {
  const montoApertura = numeroOCero(req.body?.monto_apertura);
  if (montoApertura < 0) return res.status(400).json({ error: 'monto_apertura no puede ser negativo.' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // FOR UPDATE sobre la CAJA (no sobre turnos_caja, que puede no tener
    // ninguna fila todavía) -- serializa dos "abrir turno" simultáneos
    // sobre la misma caja: el segundo espera a que el primero haga
    // COMMIT/ROLLBACK, y para entonces ya ve el turno recién insertado.
    const restringido = req.sucursalRestringida != null;
    const condSucursal = restringido ? ' AND sucursal_id = $3' : '';
    const valoresCaja = restringido
      ? [req.params.id, req.usuario.empresa_id, req.sucursalRestringida]
      : [req.params.id, req.usuario.empresa_id];
    const { rows: cajaRows } = await cliente.query(
      `SELECT * FROM cajas WHERE id = $1 AND empresa_id = $2${condSucursal} FOR UPDATE`,
      valoresCaja
    );
    if (!cajaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Caja no encontrada.' }); }
    const caja = cajaRows[0];
    if (!caja.activa) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Esta caja está desactivada.' }); }

    // Un turno abierto como máximo por caja -- este chequeo da un mensaje
    // claro; el UNIQUE parcial de la migración 040 es la garantía real
    // contra una carrera que este candado no alcance a cubrir (ver catch
    // del código 23505 más abajo).
    const { rows: abiertoRows } = await cliente.query(
      `SELECT id FROM turnos_caja WHERE caja_id = $1 AND estado = 'abierto'`,
      [caja.id]
    );
    if (abiertoRows.length) { await cliente.query('ROLLBACK'); return res.status(409).json({ error: 'Esta caja ya tiene un turno abierto.' }); }

    const { rows: turnoRows } = await cliente.query(
      `INSERT INTO turnos_caja (caja_id, empresa_id, usuario_apertura_id, monto_apertura) VALUES ($1,$2,$3,$4) RETURNING *`,
      [caja.id, req.usuario.empresa_id, req.usuario.id, montoApertura]
    );
    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'crear', modulo: 'cajas', registroId: turnoRows[0].id,
      detalle: { accion: 'abrir_turno', caja: caja.nombre, monto_apertura: montoApertura }
    });
    await cliente.query('COMMIT');
    res.status(201).json(turnoRows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Esta caja ya tiene un turno abierto.' });
    console.error(err);
    res.status(500).json({ error: 'No se pudo abrir el turno.' });
  } finally {
    cliente.release();
  }
});

// PUT /api/cajas/turnos/:id/cerrar -- { monto_cierre_declarado, notas }
// Cualquiera con cajas.editar puede cerrar, no solo quien abrió (cambio de
// turno entre empleados es normal) -- decisión explícita.
router.put('/turnos/:id/cerrar', verificarPermiso('cajas.editar'), async (req, res) => {
  const montoDeclaradoCrudo = req.body?.monto_cierre_declarado;
  if (montoDeclaradoCrudo === undefined || montoDeclaradoCrudo === null || montoDeclaradoCrudo === '') {
    return res.status(400).json({ error: 'monto_cierre_declarado es requerido.' });
  }
  const montoDeclarado = numeroOCero(montoDeclaradoCrudo);
  if (montoDeclarado < 0) return res.status(400).json({ error: 'monto_cierre_declarado no puede ser negativo.' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const restringido = req.sucursalRestringida != null;
    const condSucursal = restringido ? ' AND c.sucursal_id = $3' : '';
    const valores = restringido
      ? [req.params.id, req.usuario.empresa_id, req.sucursalRestringida]
      : [req.params.id, req.usuario.empresa_id];
    const { rows: turnoRows } = await cliente.query(
      `SELECT t.* FROM turnos_caja t JOIN cajas c ON c.id = t.caja_id
       WHERE t.id = $1 AND t.empresa_id = $2${condSucursal} FOR UPDATE OF t`,
      valores
    );
    if (!turnoRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Turno no encontrado.' }); }
    const turno = turnoRows[0];
    if (turno.estado !== 'abierto') {
      await cliente.query('ROLLBACK');
      return res.status(409).json({ error: 'Este turno ya está cerrado.' });
    }

    // Arqueo: monto_cierre_sistema = apertura + (ingresos - egresos) de
    // finanzas durante ESTE turno. Ver el supuesto de "todo es efectivo"
    // documentado al inicio del archivo y en la migración 040.
    const { rows: netoRows } = await cliente.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END), 0) AS neto
       FROM finanzas WHERE turno_caja_id = $1 AND empresa_id = $2`,
      [turno.id, req.usuario.empresa_id]
    );
    const neto = Number(netoRows[0].neto);
    const montoSistema = +(Number(turno.monto_apertura) + neto).toFixed(2);
    const diferencia = +(montoDeclarado - montoSistema).toFixed(2);

    const { rows: actualizado } = await cliente.query(
      `UPDATE turnos_caja SET
         estado = 'cerrado', usuario_cierre_id = $1, monto_cierre_declarado = $2,
         monto_cierre_sistema = $3, diferencia = $4, fecha_cierre = now(),
         notas = COALESCE($5, notas)
       WHERE id = $6 RETURNING *`,
      [req.usuario.id, montoDeclarado, montoSistema, diferencia, req.body?.notas || null, turno.id]
    );

    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'editar', modulo: 'cajas', registroId: turno.id,
      detalle: {
        accion: 'cerrar_turno', monto_apertura: Number(turno.monto_apertura),
        monto_cierre_declarado: montoDeclarado, monto_cierre_sistema: montoSistema, diferencia
      }
    });
    await cliente.query('COMMIT');
    res.json(actualizado[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo cerrar el turno.' });
  } finally {
    cliente.release();
  }
});

// PUT /api/cajas/:id -- { nombre?, activa? }
router.put('/:id', verificarPermiso('cajas.editar'), async (req, res) => {
  const bodyTieneNombre = Object.prototype.hasOwnProperty.call(req.body || {}, 'nombre');
  const bodyTieneActiva = Object.prototype.hasOwnProperty.call(req.body || {}, 'activa');
  const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : req.body?.nombre;
  if (bodyTieneNombre && !nombre) return res.status(400).json({ error: 'nombre no puede quedar vacío' });

  const restringido = req.sucursalRestringida != null;
  const condSucursal = restringido ? ' AND sucursal_id = $3' : '';
  const valoresSelect = restringido
    ? [req.params.id, req.usuario.empresa_id, req.sucursalRestringida]
    : [req.params.id, req.usuario.empresa_id];
  try {
    const { rows: antesRows } = await pool.query(`SELECT * FROM cajas WHERE id = $1 AND empresa_id = $2${condSucursal}`, valoresSelect);
    if (!antesRows.length) return res.status(404).json({ error: 'Caja no encontrada.' });

    // $1/$2 = id/empresa_id, $3-$6 = flags "provisto"+valor de nombre/activa
    // (patrón ya usado en sucursales.js), $7 = sucursal_id solo si aplica.
    const valoresUpdate = [req.params.id, req.usuario.empresa_id, bodyTieneNombre, nombre, bodyTieneActiva, req.body?.activa];
    if (restringido) valoresUpdate.push(req.sucursalRestringida);
    const sqlUpdate = `UPDATE cajas SET
         nombre = CASE WHEN $3 THEN $4 ELSE nombre END,
         activa = CASE WHEN $5 THEN $6 ELSE activa END
       WHERE id = $1 AND empresa_id = $2${restringido ? ' AND sucursal_id = $7' : ''} RETURNING *`;

    const { rows } = await pool.query(sqlUpdate, valoresUpdate);
    if (!rows.length) return res.status(404).json({ error: 'Caja no encontrada.' });
    res.json(rows[0]);
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'cajas', registroId: req.params.id, detalle: { antes: antesRows[0], despues: rows[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la caja.' });
  }
});

// DELETE /api/cajas/:id -- bloqueada si tiene CUALQUIER historial de turnos
// (abiertos o cerrados) -- "caja sin historial se puede eliminar" fue la
// decisión explícita, no solo "sin turno abierto".
router.delete('/:id', verificarPermiso('cajas.eliminar'), async (req, res) => {
  const restringido = req.sucursalRestringida != null;
  const condSucursal = restringido ? ' AND sucursal_id = $3' : '';
  const valores = restringido
    ? [req.params.id, req.usuario.empresa_id, req.sucursalRestringida]
    : [req.params.id, req.usuario.empresa_id];
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // FOR UPDATE: mismo candado que "abrir turno" -- sin esto, un "abrir
    // turno" concurrente sobre esta misma caja podría colarse justo entre
    // el chequeo de historial y el DELETE de abajo.
    const { rows: antesRows } = await cliente.query(`SELECT * FROM cajas WHERE id = $1 AND empresa_id = $2${condSucursal} FOR UPDATE`, valores);
    if (!antesRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Caja no encontrada.' }); }

    const { rows: historialRows } = await cliente.query(`SELECT count(*)::int AS n FROM turnos_caja WHERE caja_id = $1`, [req.params.id]);
    if (historialRows[0].n > 0) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({ error: 'No se puede eliminar: esta caja tiene historial de turnos.' });
    }

    await cliente.query(`DELETE FROM cajas WHERE id = $1 AND empresa_id = $2${condSucursal}`, valores);
    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'eliminar', modulo: 'cajas', registroId: req.params.id, detalle: { eliminado: antesRows[0] } });
    await cliente.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo eliminar la caja.' });
  } finally {
    cliente.release();
  }
});

export default router;
