// src/routes/comboVentas.js
// La pieza genuinamente nueva del vertical: vender un combo descuenta
// VARIOS productos de inventario en una sola transacción SQL (uno por cada
// elemento de combo.items, multiplicado por la cantidad de combos
// vendidos). Todo lo demás en esta app (ventas.js, postventa.js,
// comandas.js) descuenta un solo producto por movimiento; acá es una lista.
// Mismo principio de fondo que ventas.js -- todo o nada, con FOR UPDATE
// para que dos ventas simultáneas del mismo producto no lean el mismo
// stock "viejo" a la vez -- solo que iterado sobre N filas de inventario
// en vez de una.

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa, requireModulo } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { alertarStockBajo } from '../notificaciones.js';

const router = Router();
router.use(auth, requireEmpresa, requireModulo('combo_ventas'));

const ESTADOS_VALIDOS = ['pendiente', 'en_preparacion', 'listo', 'entregado', 'cancelado'];

function numeroOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Descuenta cantidadCombos × item.cantidad de cada producto del combo.
// Bloquea (FOR UPDATE) cada fila de inventario ANTES de revisar el stock de
// ninguna -- si dos ventas del mismo combo llegan a la vez, la segunda
// espera a que la primera termine (COMMIT/ROLLBACK) en vez de leer stock
// que ya no es real. Si algún producto no alcanza, no se descuenta NADA
// (se corta antes del primer UPDATE) y se informa cuál faltó.
async function descontarItemsCombo(cliente, empresaId, items, cantidadCombos) {
  const productos = [];
  for (const item of items) {
    const { rows } = await cliente.query(
      `SELECT id, nombre, stock FROM inventario WHERE id=$1 AND empresa_id=$2 FOR UPDATE`,
      [item.producto_id, empresaId]
    );
    if (!rows.length) return { error: `El producto "${item.producto_nombre}" del combo ya no existe en inventario.` };
    const necesario = item.cantidad * cantidadCombos;
    if (Number(rows[0].stock) < necesario) {
      return { error: `Stock insuficiente de "${rows[0].nombre}": quedan ${rows[0].stock} y el combo necesita ${necesario}.` };
    }
    productos.push({ id: rows[0].id, necesario });
  }
  for (const p of productos) {
    await cliente.query(`UPDATE inventario SET stock = stock - $1, actualizado_el = now() WHERE id=$2 AND empresa_id=$3`, [p.necesario, p.id, empresaId]);
  }
  return {};
}

async function devolverItemsCombo(cliente, empresaId, items, cantidadCombos) {
  for (const item of items) {
    await cliente.query(
      `UPDATE inventario SET stock = stock + $1, actualizado_el = now() WHERE id=$2 AND empresa_id=$3`,
      [item.cantidad * cantidadCombos, item.producto_id, empresaId]
    );
  }
}

router.get('/', verificarPermiso('combo_ventas.ver'), async (req, res) => {
  const { desde, hasta } = req.query;
  const valores = [req.usuario.empresa_id];
  const condiciones = [`empresa_id = $1`];
  if (desde) { valores.push(desde); condiciones.push(`fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`fecha <= $${valores.length}`); }
  try {
    const { rows } = await pool.query(`SELECT * FROM combo_ventas WHERE ${condiciones.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT 5000`, valores);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las ventas de combos.' });
  }
});

router.post('/', verificarPermiso('combo_ventas.crear'), async (req, res) => {
  const { fecha, combo_id, mesa_id, cantidad, estado, notas } = req.body;
  const cant = numeroOCero(cantidad) || 1;
  const empresaId = req.usuario.empresa_id;

  if (!fecha) return res.status(400).json({ error: 'fecha es requerido' });
  if (!combo_id) return res.status(400).json({ error: 'Selecciona un combo.' });
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'pendiente';

  let productosParaAlertar = []; // aviso de stock bajo: tras el COMMIT y con la conexión liberada (ver src/notificaciones.js)
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const { rows: comboRows } = await cliente.query(`SELECT * FROM combos WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [combo_id, empresaId]);
    if (!comboRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El combo seleccionado no existe.' }); }
    const combo = comboRows[0];
    if (combo.estado !== 'activo') { await cliente.query('ROLLBACK'); return res.status(400).json({ error: `El combo "${combo.nombre}" no está activo.` }); }

    let mesaNumero = null;
    if (mesa_id) {
      const { rows: mesaRows } = await cliente.query(`SELECT numero FROM mesas WHERE id=$1 AND empresa_id=$2`, [mesa_id, empresaId]);
      if (!mesaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'La mesa seleccionada no existe.' }); }
      mesaNumero = mesaRows[0].numero;
    }

    const { error } = await descontarItemsCombo(cliente, empresaId, combo.items, cant);
    if (error) { await cliente.query('ROLLBACK'); return res.status(409).json({ error }); }

    const precio = Number(combo.precio);
    const monto = +(cant * precio).toFixed(2);

    const { rows } = await cliente.query(
      `INSERT INTO combo_ventas (fecha, combo_id, combo_nombre, mesa_id, mesa_numero, cantidad, precio_unitario, monto, estado, notas, empresa_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [fecha, combo.id, combo.nombre, mesa_id || null, mesaNumero, cant, precio, monto, estadoFinal, notas || null, empresaId]
    );
    const venta = rows[0];

    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'crear', modulo: 'combo_ventas', registroId: venta.id,
      detalle: { ...venta, items_descontados: combo.items }
    });
    await cliente.query('COMMIT');
    productosParaAlertar = (combo.items || []).map(item => item.producto_id);
    res.status(201).json(venta);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo registrar la venta del combo.' });
  } finally {
    cliente.release();
  }
  if (productosParaAlertar.length) await alertarStockBajo(empresaId, productosParaAlertar);
});

// combo_id/mesa_id son INMUTABLES después de creada (mismo criterio que
// comandas.js) -- se puede corregir cantidad (ajusta TODOS los items del
// combo por la diferencia, en una sola transacción) y estado.
router.put('/:id', verificarPermiso('combo_ventas.editar'), async (req, res) => {
  const { fecha, cantidad, estado, notas } = req.body;
  const nuevaCant = cantidad !== undefined && cantidad !== '' ? numeroOCero(cantidad) : null;
  if (nuevaCant !== null && nuevaCant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  if (estado && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
  const empresaId = req.usuario.empresa_id;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: ventaRows } = await cliente.query(`SELECT * FROM combo_ventas WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [req.params.id, empresaId]);
    if (!ventaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada.' }); }
    const antes = ventaRows[0];

    let cantidadFinal = Number(antes.cantidad);
    if (nuevaCant !== null && nuevaCant !== Number(antes.cantidad)) {
      const { rows: comboRows } = await cliente.query(`SELECT items FROM combos WHERE id=$1 AND empresa_id=$2`, [antes.combo_id, empresaId]);
      if (!comboRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El combo de esta venta ya no existe.' }); }
      const diferencia = nuevaCant - Number(antes.cantidad); // positivo = vende mas, negativo = devuelve
      if (diferencia > 0) {
        const { error } = await descontarItemsCombo(cliente, empresaId, comboRows[0].items, diferencia);
        if (error) { await cliente.query('ROLLBACK'); return res.status(409).json({ error }); }
      } else if (diferencia < 0) {
        await devolverItemsCombo(cliente, empresaId, comboRows[0].items, -diferencia);
      }
      cantidadFinal = nuevaCant;
    }

    const montoFinal = +(cantidadFinal * Number(antes.precio_unitario)).toFixed(2);
    const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : antes.estado;

    const { rows } = await cliente.query(
      `UPDATE combo_ventas SET fecha = COALESCE($1, fecha), cantidad = $2, monto = $3, estado = $4, notas = $5, actualizado_el = now()
       WHERE id=$6 AND empresa_id=$7 RETURNING *`,
      [fecha || null, cantidadFinal, montoFinal, estadoFinal, notas !== undefined ? notas : antes.notas, req.params.id, empresaId]
    );

    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'editar', modulo: 'combo_ventas', registroId: req.params.id, detalle: { antes, despues: rows[0] } });
    await cliente.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la venta.' });
  } finally {
    cliente.release();
  }
});

router.delete('/:id', verificarPermiso('combo_ventas.eliminar'), async (req, res) => {
  const empresaId = req.usuario.empresa_id;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(`SELECT * FROM combo_ventas WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [req.params.id, empresaId]);
    if (!rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada.' }); }
    const venta = rows[0];

    const { rows: comboRows } = await cliente.query(`SELECT items FROM combos WHERE id=$1 AND empresa_id=$2`, [venta.combo_id, empresaId]);
    if (comboRows.length) {
      await devolverItemsCombo(cliente, empresaId, comboRows[0].items, Number(venta.cantidad));
    }
    await cliente.query(`DELETE FROM combo_ventas WHERE id=$1 AND empresa_id=$2`, [venta.id, empresaId]);

    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'eliminar', modulo: 'combo_ventas', registroId: venta.id, detalle: { eliminado: venta } });
    await cliente.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo borrar la venta.' });
  } finally {
    cliente.release();
  }
});

export default router;
