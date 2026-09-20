// src/routes/comandas.js
// Un plato pedido en una mesa. Mismo patrón transaccional que
// ventas.js/postventa.js: el stock del producto se descuenta al crear la
// comanda (FOR UPDATE para que dos comandas simultáneas del mismo producto
// no lean el mismo stock "viejo" a la vez), se ajusta si cambia la
// cantidad, y se devuelve si se borra. A diferencia de ventas.js, NO genera
// un ingreso automático en Finanzas -- mismo criterio que postventa.js: el
// cobro real de la mesa se registra aparte, cuando el negocio decida cómo
// (esto es solo el pedido a cocina).

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa, requireModulo } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { alertarStockBajo } from '../notificaciones.js';

const router = Router();
router.use(auth, requireEmpresa, requireModulo('comandas'));

const ESTADOS_VALIDOS = ['pendiente', 'en_preparacion', 'listo', 'entregado', 'cancelado'];

function numeroOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

router.get('/', verificarPermiso('comandas.ver'), async (req, res) => {
  const { desde, hasta } = req.query;
  const valores = [req.usuario.empresa_id];
  const condiciones = [`empresa_id = $1`];
  if (desde) { valores.push(desde); condiciones.push(`fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`fecha <= $${valores.length}`); }
  try {
    const { rows } = await pool.query(`SELECT * FROM comandas WHERE ${condiciones.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT 5000`, valores);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las comandas.' });
  }
});

router.post('/', verificarPermiso('comandas.crear'), async (req, res) => {
  const { fecha, mesa_id, producto_id, cantidad, estado, notas } = req.body;
  const cant = numeroOCero(cantidad) || 1;
  const empresaId = req.usuario.empresa_id;

  if (!fecha) return res.status(400).json({ error: 'fecha es requerido' });
  if (!mesa_id) return res.status(400).json({ error: 'Selecciona una mesa.' });
  if (!producto_id) return res.status(400).json({ error: 'Selecciona un producto del inventario.' });
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'pendiente';

  let alertarProductoId = null; // aviso de stock bajo: tras el COMMIT y con la conexión liberada (ver src/notificaciones.js)
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const { rows: mesaRows } = await cliente.query(`SELECT numero FROM mesas WHERE id=$1 AND empresa_id=$2`, [mesa_id, empresaId]);
    if (!mesaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'La mesa seleccionada no existe.' }); }

    const { rows: prodRows } = await cliente.query(
      `SELECT id, nombre, precio_unitario, stock FROM inventario WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [producto_id, empresaId]
    );
    if (!prodRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El producto seleccionado ya no existe en inventario.' }); }
    const producto = prodRows[0];

    if (Number(producto.stock) < cant) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({
        error: `Stock insuficiente: quedan ${producto.stock} unidad(es) de "${producto.nombre}" y se pidieron ${cant}.`,
        stockDisponible: Number(producto.stock)
      });
    }

    const precio = Number(producto.precio_unitario) || 0;
    const monto = +(cant * precio).toFixed(2);

    const { rows } = await cliente.query(
      `INSERT INTO comandas (fecha, mesa_id, mesa_numero, producto_id, producto_nombre, cantidad, precio_unitario, monto, estado, notas, empresa_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [fecha, mesa_id, mesaRows[0].numero, producto.id, producto.nombre, cant, precio, monto, estadoFinal, notas || null, empresaId]
    );
    const comanda = rows[0];

    await cliente.query(`UPDATE inventario SET stock = stock - $1, actualizado_el = now() WHERE id=$2 AND empresa_id=$3`, [cant, producto.id, empresaId]);

    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'crear', modulo: 'comandas', registroId: comanda.id, detalle: comanda });
    await cliente.query('COMMIT');
    alertarProductoId = producto.id;
    res.status(201).json(comanda);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo registrar la comanda.' });
  } finally {
    cliente.release();
  }
  if (alertarProductoId) await alertarStockBajo(empresaId, [alertarProductoId]);
});

// mesa_id/producto_id son INMUTABLES después de creada (mismo criterio que
// postventa.js con cliente_id/vehiculo_id/repuesto_id) -- si cambió de
// mesa o de plato, es un pedido distinto, se cancela y se crea de nuevo.
// Sí se puede corregir cantidad (ajusta el stock por la diferencia) y estado.
router.put('/:id', verificarPermiso('comandas.editar'), async (req, res) => {
  const { fecha, cantidad, estado, notas } = req.body;
  const nuevaCant = cantidad !== undefined && cantidad !== '' ? numeroOCero(cantidad) : null;
  if (nuevaCant !== null && nuevaCant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  if (estado && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
  const empresaId = req.usuario.empresa_id;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: comandaRows } = await cliente.query(`SELECT * FROM comandas WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [req.params.id, empresaId]);
    if (!comandaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Comanda no encontrada.' }); }
    const antes = comandaRows[0];

    let cantidadFinal = Number(antes.cantidad);
    if (nuevaCant !== null && nuevaCant !== Number(antes.cantidad)) {
      const diferencia = nuevaCant - Number(antes.cantidad);
      const { rows: prodRows } = await cliente.query(`SELECT id, stock FROM inventario WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [antes.producto_id, empresaId]);
      if (!prodRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El producto de esta comanda ya no existe en inventario.' }); }
      if (diferencia > 0 && Number(prodRows[0].stock) < diferencia) {
        await cliente.query('ROLLBACK');
        return res.status(409).json({ error: `Stock insuficiente para aumentar la cantidad: solo quedan ${prodRows[0].stock} unidad(es) más.` });
      }
      await cliente.query(`UPDATE inventario SET stock = stock - $1, actualizado_el = now() WHERE id=$2 AND empresa_id=$3`, [diferencia, antes.producto_id, empresaId]);
      cantidadFinal = nuevaCant;
    }

    const montoFinal = +(cantidadFinal * Number(antes.precio_unitario)).toFixed(2);
    const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : antes.estado;

    const { rows } = await cliente.query(
      `UPDATE comandas SET fecha = COALESCE($1, fecha), cantidad = $2, monto = $3, estado = $4, notas = $5, actualizado_el = now()
       WHERE id=$6 AND empresa_id=$7 RETURNING *`,
      [fecha || null, cantidadFinal, montoFinal, estadoFinal, notas !== undefined ? notas : antes.notas, req.params.id, empresaId]
    );

    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'editar', modulo: 'comandas', registroId: req.params.id, detalle: { antes, despues: rows[0] } });
    await cliente.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la comanda.' });
  } finally {
    cliente.release();
  }
});

router.delete('/:id', verificarPermiso('comandas.eliminar'), async (req, res) => {
  const empresaId = req.usuario.empresa_id;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(`SELECT * FROM comandas WHERE id=$1 AND empresa_id=$2 FOR UPDATE`, [req.params.id, empresaId]);
    if (!rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Comanda no encontrada.' }); }
    const comanda = rows[0];

    await cliente.query(`UPDATE inventario SET stock = stock + $1, actualizado_el = now() WHERE id=$2 AND empresa_id=$3`, [comanda.cantidad, comanda.producto_id, empresaId]);
    await cliente.query(`DELETE FROM comandas WHERE id=$1 AND empresa_id=$2`, [comanda.id, empresaId]);

    await registrarAuditoria(cliente, { usuario: req.usuario, accion: 'eliminar', modulo: 'comandas', registroId: comanda.id, detalle: { eliminado: comanda, stockDevuelto: comanda.cantidad } });
    await cliente.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo borrar la comanda.' });
  } finally {
    cliente.release();
  }
});

export default router;
