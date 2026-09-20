// src/routes/ventas.js
// Fase 5: Ventas deja de ser un CRUD genérico de crudFactory.js porque ahora
// tiene que hacer tres cosas juntas o ninguna (por eso todo vive en una sola
// transacción SQL: BEGIN...COMMIT/ROLLBACK):
//   1. Validar que el producto tenga stock suficiente.
//   2. Descontar ese stock de inventario.
//   3. Dejar un movimiento de ingreso en finanzas.
// Si el servidor se cae a mitad de esto, PostgreSQL revierte todo -- nunca
// queda una venta sin su descuento de stock, ni un stock descontado sin venta.
//
// Fase A (multi-tenant): cada SELECT/UPDATE/DELETE de este archivo agrega
// "AND empresa_id = $N" -- ventas.js es manual (no pasa por crudFactory.js),
// así que este scoping no sale gratis como en clientes.js/inventario.js.

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa, requireModulo } from '../middleware/auth.js';
import { resolverRestriccionSucursal } from '../middleware/sucursal.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { alertarStockBajo } from '../notificaciones.js';

const router = Router();
router.use(auth, requireEmpresa, resolverRestriccionSucursal, requireModulo('ventas'));

function numeroOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// V-06 (auditoría de seguridad): el precio sigue siendo manual a propósito
// (descuentos, precios negociados -- ver comentario arriba), pero ya no
// puede ser CUALQUIER precio positivo. Rango ±30% respecto al precio de
// catálogo (inventario.precio_unitario). Si el producto no tiene precio de
// catálogo cargado (0 -- inventario.precio_unitario es NOT NULL DEFAULT 0,
// así que "sin precio" es un valor real y esperado, no un error), no hay
// contra qué validar y se permite cualquier precio positivo, igual que
// antes -- no tiene sentido bloquear ventas de un producto que nunca tuvo
// precio de catálogo.
const RANGO_PRECIO = 0.30;

function validarRangoPrecio(precio, precioCatalogo) {
  if (!precioCatalogo || precioCatalogo <= 0) return { ok: true };
  // .toFixed(2) normaliza el error de punto flotante de multiplicar por 0.7
  // (100 * 0.7 = 70.00000000000001 en JS) -- sin esto, un precio exactamente
  // en el límite del rango podía rechazarse por error.
  const min = +(precioCatalogo * (1 - RANGO_PRECIO)).toFixed(2);
  const max = +(precioCatalogo * (1 + RANGO_PRECIO)).toFixed(2);
  const precioRedondeado = +precio.toFixed(2);
  if (precioRedondeado < min || precioRedondeado > max) return { ok: false, min, max };
  return { ok: true };
}

// Arma el detalle de desviación para auditoría -- null si el precio cobrado
// coincide con el de catálogo (no hay nada que registrar de más).
function desviacionPrecio(precio, precioCatalogo) {
  if (!precioCatalogo || precioCatalogo <= 0) return null;
  const precioRedondeado = +precio.toFixed(2);
  if (precioRedondeado === +precioCatalogo.toFixed(2)) return null;
  return {
    precio_catalogo: precioCatalogo,
    precio_cobrado: precioRedondeado,
    desviacion_pct: +(((precioRedondeado - precioCatalogo) / precioCatalogo) * 100).toFixed(2)
  };
}

// GET /?desde&hasta -- igual que el CRUD generico, solo lectura.
// Paginación (Fase 3, Eje A) opt-in, mismo criterio que crudFactory.js:
// sin ?pagina=/?page=, responde igual que siempre (array plano, hasta
// 5000 filas) -- js/modoBackend.js asume un array plano acá también.
router.get('/', verificarPermiso('ventas.ver'), async (req, res) => {
  const { desde, hasta, limite, pagina, page, sucursal_id } = req.query;
  const valores = [req.usuario.empresa_id];
  const condiciones = [`empresa_id = $1`];
  if (desde) { valores.push(desde); condiciones.push(`fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`fecha <= $${valores.length}`); }
  // Opt-in, mismo criterio que columnasFiltroExacto de crudFactory.js: sin
  // el query param, trae todo igual que siempre (incluidas las ventas
  // históricas con sucursal_id null, de antes de esta sub-fase).
  //
  // Sub-fase D: si el usuario está restringido, su sucursal SIEMPRE gana --
  // nunca el query param del cliente en ese caso (un pedido explícito de
  // otra ya lo cortó resolverRestriccionSucursal con 403 antes de llegar
  // acá). Esto decide el valor EFECTIVO, no relee sin más req.query.
  const sucursalEfectiva = req.sucursalRestringida ?? sucursal_id;
  if (sucursalEfectiva) { valores.push(sucursalEfectiva); condiciones.push(`sucursal_id = $${valores.length}`); }
  const where = `WHERE ${condiciones.join(' AND ')}`;
  try {
    const paginaCruda = pagina ?? page;
    if (paginaCruda !== undefined) {
      const paginaFinal = Math.max(parseInt(paginaCruda, 10) || 1, 1);
      const limiteFinal = Math.min(Math.max(parseInt(limite, 10) || 50, 1), 100);
      const offset = (paginaFinal - 1) * limiteFinal;
      const [{ rows: datos }, { rows: totalRows }] = await Promise.all([
        pool.query(`SELECT * FROM ventas ${where} ORDER BY fecha DESC, id DESC LIMIT ${limiteFinal} OFFSET ${offset}`, valores),
        pool.query(`SELECT count(*)::int AS total FROM ventas ${where}`, valores)
      ]);
      const total = totalRows[0].total;
      return res.json({
        datos,
        meta: { total, pagina: paginaFinal, limite: limiteFinal, paginasTotales: Math.ceil(total / limiteFinal) }
      });
    }
    const { rows } = await pool.query(`SELECT * FROM ventas ${where} ORDER BY fecha DESC, id DESC LIMIT 5000`, valores);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las ventas.' });
  }
});

// POST / -- body: { fecha, cliente_id, producto_id, cantidad, notas }
// El precio y la categoria YA NO se escriben a mano: se toman del producto
// en inventario al momento de vender (asi nadie puede inventar un precio
// distinto al que dice el catalogo).
// POST / -- body: { fecha, cliente_id, producto_id, categoria, cantidad, precio_unitario, notas }
// A pedido: categoria y precio_unitario vuelven a ser MANUALES (antes de esto
// se tomaban del catálogo de inventario). producto_id se sigue exigiendo
// igual -- es lo que permite validar y descontar el stock -- pero el precio
// que se cobra ya no tiene por qué ser el que dice inventario (ej. descuentos,
// precio negociado).
// Sub-fase C (sucursales): el body NO lleva sucursal_id -- se deriva del
// producto (cada fila de inventario ya pertenece a una sola sucursal desde
// la Sub-fase B), ver el INSERT INTO ventas más abajo.
// Sub-fase E (cajas): turno_caja_id es OPCIONAL -- sin él, la venta se
// comporta exactamente igual que antes de esta sub-fase (sin caja
// asociada). Si se manda, tiene que ser un turno ABIERTO cuya caja esté en
// la MISMA sucursal que el producto vendido -- no tendría sentido vender
// algo de la Sucursal Principal contra un turno abierto en la Sede B.
router.post('/', verificarPermiso('ventas.crear'), async (req, res) => {
  const { fecha, cliente_id, producto_id, categoria, cantidad, precio_unitario, notas, turno_caja_id, campana_id } = req.body;
  const cant = numeroOCero(cantidad);
  const precio = numeroOCero(precio_unitario);
  const empresaId = req.usuario.empresa_id;
  // Marketing (paso 9): la venta puede atribuirse a una campaña. Vacío = sin campaña.
  const quiereCampana = campana_id !== undefined && campana_id !== null && campana_id !== '';
  if (quiereCampana && !(Number.isInteger(Number(campana_id)) && Number(campana_id) > 0)) {
    return res.status(400).json({ error: 'campana_id debe ser un número entero.' });
  }

  if (!fecha) return res.status(400).json({ error: 'fecha es requerido' });
  if (!producto_id) return res.status(400).json({ error: 'Selecciona un producto del inventario.' });
  if (!cliente_id) return res.status(400).json({ error: 'Selecciona un cliente registrado (o crea uno nuevo).' });
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  if (precio <= 0) return res.status(400).json({ error: 'El precio unitario debe ser mayor a 0.' });
  if (turno_caja_id !== undefined && turno_caja_id !== null && turno_caja_id !== '' && !Number.isInteger(turno_caja_id)) {
    return res.status(400).json({ error: 'turno_caja_id debe ser un número entero.' });
  }

  // Aviso de stock bajo: se decide DESPUÉS del COMMIT y con la conexión ya
  // liberada (ver src/notificaciones.js) -- nunca dentro de la transacción.
  let alertarProductoId = null;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // FOR UPDATE: bloquea la fila del producto hasta el COMMIT/ROLLBACK, asi
    // dos ventas simultaneas del mismo producto no pueden leer el mismo stock
    // "viejo" a la vez y las dos pasar la validacion por error.
    //
    // Sub-fase D: acceso INDIRECTO por producto_id (no un query param
    // explícito) -- si el usuario está restringido y el producto es de otra
    // sucursal, la condición va directo acá, en el WHERE de la SELECT
    // inicial (nunca "traer y comparar después"): el resultado es el mismo
    // 404 genérico de "no existe", sin revelar que sí existe en otra sede.
    const { rows: prodRows } = await cliente.query(
      `SELECT id, nombre, categoria AS categoria_catalogo, stock, precio_unitario AS precio_catalogo, sucursal_id
       FROM inventario WHERE id = $1 AND empresa_id = $2 AND ($3::int IS NULL OR sucursal_id = $3) FOR UPDATE`,
      [producto_id, empresaId, req.sucursalRestringida ?? null]
    );
    if (!prodRows.length) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'El producto seleccionado ya no existe en inventario.' });
    }
    const producto = prodRows[0];
    const precioCatalogo = Number(producto.precio_catalogo) || 0;

    if (Number(producto.stock) < cant) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({
        error: `Stock insuficiente: quedan ${producto.stock} unidad(es) de "${producto.nombre}" y se intento vender ${cant}.`,
        stockDisponible: Number(producto.stock)
      });
    }

    // V-06: el precio manual sigue permitido, pero no CUALQUIER precio --
    // ver validarRangoPrecio() arriba.
    const rangoPrecio = validarRangoPrecio(precio, precioCatalogo);
    if (!rangoPrecio.ok) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({
        error: `El precio debe estar entre S/ ${rangoPrecio.min.toFixed(2)} y S/ ${rangoPrecio.max.toFixed(2)} (±30% del precio de catálogo de "${producto.nombre}": S/ ${precioCatalogo.toFixed(2)}).`
      });
    }

    const { rows: cliRows } = await cliente.query(`SELECT id, nombre FROM clientes WHERE id = $1 AND empresa_id = $2`, [cliente_id, empresaId]);
    if (!cliRows.length) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'El cliente seleccionado ya no existe.' });
    }
    const clienteRow = cliRows[0];

    // Sub-fase E: el turno tiene que estar ABIERTO y su caja tiene que
    // estar en la MISMA sucursal que el producto -- 400 (no 404) porque
    // esto es una inconsistencia del pedido en sí, no un intento de acceder
    // a algo ajeno (el usuario eligió ambos, producto y turno, a propósito).
    let turnoCajaIdFinal = null;
    if (turno_caja_id !== undefined && turno_caja_id !== null && turno_caja_id !== '') {
      const { rows: turnoRows } = await cliente.query(
        `SELECT t.id FROM turnos_caja t JOIN cajas c ON c.id = t.caja_id
         WHERE t.id = $1 AND t.empresa_id = $2 AND t.estado = 'abierto' AND c.sucursal_id = $3`,
        [turno_caja_id, empresaId, producto.sucursal_id]
      );
      if (!turnoRows.length) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ error: 'El turno indicado no está abierto o no corresponde a la sucursal de este producto.' });
      }
      turnoCajaIdFinal = turnoRows[0].id;
    }

    // La campaña tiene que ser de ESTA empresa y no estar finalizada. Solo se consulta
    // cuando la venta trae campaña: una venta normal no toca las tablas de marketing.
    let campanaIdFinal = null;
    if (quiereCampana) {
      const { rows: campRows } = await cliente.query(`SELECT id, estado FROM campanas WHERE id = $1 AND empresa_id = $2`, [Number(campana_id), empresaId]);
      if (!campRows.length) {
        await cliente.query('ROLLBACK');
        return res.status(404).json({ error: 'La campaña seleccionada ya no existe.' });
      }
      if (campRows[0].estado === 'finalizada') {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ error: 'Esa campaña ya está finalizada: elige una activa o registra la venta sin campaña.' });
      }
      campanaIdFinal = campRows[0].id;
    }

    const categoriaFinal = categoria || producto.categoria_catalogo || null;
    const monto = +(cant * precio).toFixed(2);

    // Sub-fase C (sucursales): sucursal_id de la venta se DERIVA del
    // producto vendido, nunca lo manda el cliente -- cada fila de
    // inventario ya pertenece a una sola sucursal desde la Sub-fase B, así
    // que es la única fuente de verdad posible (evita que alguien mande
    // "sucursal X" mientras el stock que de verdad se descuenta es de la
    // sucursal Y). Mismo criterio que empresa_id: siempre server-side.
    const { rows: ventaRows } = await cliente.query(
      `INSERT INTO ventas (fecha, cliente, cliente_id, producto, producto_id, categoria, cantidad, precio_unitario, monto, notas, empresa_id, sucursal_id, turno_caja_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [fecha, clienteRow.nombre, clienteRow.id, producto.nombre, producto.id, categoriaFinal, cant, precio, monto, notas || null, empresaId, producto.sucursal_id, turnoCajaIdFinal]
    );
    const venta = ventaRows[0];

    // Atribución a la campaña: la venta cuenta como resultado, y el cliente figura como
    // convertido en su lista (se agrega si no estaba: alguien que compró por la campaña
    // sin haber sido contactado por la lista sigue siendo un resultado de la campaña).
    if (campanaIdFinal) {
      await cliente.query(`UPDATE ventas SET campana_id = $1 WHERE id = $2 AND empresa_id = $3`, [campanaIdFinal, venta.id, empresaId]);
      venta.campana_id = campanaIdFinal;
      await cliente.query(
        `INSERT INTO campana_clientes (campana_id, cliente_id, empresa_id, estado, etiqueta, contactado_el, respondio_el, convirtio_el)
         VALUES ($1, $2, $3, 'convirtio', 'Venta directa', now(), now(), now())
         ON CONFLICT (campana_id, cliente_id) DO UPDATE SET estado = 'convirtio',
           contactado_el = COALESCE(campana_clientes.contactado_el, now()), respondio_el = COALESCE(campana_clientes.respondio_el, now()),
           convirtio_el = COALESCE(campana_clientes.convirtio_el, now())`,
        [campanaIdFinal, clienteRow.id, empresaId]
      );
    }

    await cliente.query(`UPDATE inventario SET stock = stock - $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [cant, producto.id, empresaId]);

    // El ingreso en finanzas hereda la misma sucursal Y el mismo
    // turno_caja_id que la venta -- dos razones: (1) el reporte de
    // ganancia por sucursal (GET /api/finanzas/resumen-sucursales) no
    // tiene que ir a buscarla con un JOIN contra ventas, y (2) el arqueo
    // de cajas.js suma SOLO finanzas, no ventas aparte (ver cajas.js) --
    // sin esto, cerrar un turno nunca vería esta venta.
    await cliente.query(
      `INSERT INTO finanzas (fecha, tipo, categoria, concepto, monto, origen_modulo, origen_id, empresa_id, sucursal_id, turno_caja_id)
       VALUES ($1, 'ingreso', 'Ventas', $2, $3, 'ventas', $4, $5, $6, $7)`,
      [fecha, `Venta de ${producto.nombre} a ${clienteRow.nombre}`, monto, venta.id, empresaId, producto.sucursal_id, turnoCajaIdFinal]
    );

    await cliente.query(
      `UPDATE clientes SET compras_totales = compras_totales + $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`,
      [monto, clienteRow.id, empresaId]
    );

    const desviacion = desviacionPrecio(precio, precioCatalogo);
    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'crear', modulo: 'ventas', registroId: venta.id,
      detalle: {
        producto: producto.nombre, cliente: clienteRow.nombre, cantidad: cant, precio_unitario: precio, monto,
        ...(desviacion ? { desviacion_precio: desviacion } : {}),
        ...(campanaIdFinal ? { campana_id: campanaIdFinal } : {})
      }
    });
    await cliente.query('COMMIT');
    alertarProductoId = producto.id;
    res.status(201).json(venta);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo registrar la venta.' });
  } finally {
    cliente.release();
  }
  if (alertarProductoId) await alertarStockBajo(empresaId, [alertarProductoId]);
});

// PUT /:id -- permite corregir fecha/notas/cantidad. Si cambia la cantidad,
// ajusta el stock por la diferencia (no lo vuelve a descontar completo).
router.put('/:id', verificarPermiso('ventas.editar'), async (req, res) => {
  const { fecha, cantidad, precio_unitario, categoria, notas } = req.body;
  const nuevaCant = cantidad !== undefined && cantidad !== '' ? numeroOCero(cantidad) : null;
  const nuevoPrecio = precio_unitario !== undefined && precio_unitario !== '' ? numeroOCero(precio_unitario) : null;
  const empresaId = req.usuario.empresa_id;

  // Mismo candado que el POST (línea ~65-66) -- faltaba acá, y sin él un PUT
  // con cantidad negativa resta stock negativo (= lo aumenta gratis) y deja
  // un monto/ingreso negativo en finanzas y clientes.compras_totales.
  if (nuevaCant !== null && nuevaCant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  if (nuevoPrecio !== null && nuevoPrecio <= 0) return res.status(400).json({ error: 'El precio unitario debe ser mayor a 0.' });

  let alertarProductoId = null; // ver el mismo patrón en el POST
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Sub-fase D: acceso indirecto por id -- va en el WHERE de la SELECT
    // inicial, no "traer y comparar después". Una venta histórica sin
    // sucursal_id (NULL) tampoco la puede tocar un usuario restringido: la
    // igualdad "sucursal_id = $3" nunca es true contra NULL.
    const { rows: ventaRows } = await cliente.query(
      `SELECT * FROM ventas WHERE id = $1 AND empresa_id = $2 AND ($3::int IS NULL OR sucursal_id = $3) FOR UPDATE`,
      [req.params.id, empresaId, req.sucursalRestringida ?? null]
    );
    if (!ventaRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada.' }); }
    const venta = ventaRows[0];

    let cantidadFinal = Number(venta.cantidad);
    const precioFinal = nuevoPrecio !== null ? nuevoPrecio : Number(venta.precio_unitario);

    // V-06: se necesita leer el producto de catálogo si cambia la cantidad
    // (para ajustar stock, como antes) o si cambia el precio (para validar
    // el rango ±30%) -- un solo SELECT cubre ambos casos, no uno por cada uno.
    const cantidadCambio = nuevaCant !== null && nuevaCant !== Number(venta.cantidad);
    let producto = null;
    let precioCatalogo = 0;
    if (cantidadCambio || nuevoPrecio !== null) {
      const { rows: prodRows } = await cliente.query(
        `SELECT id, stock, precio_unitario AS precio_catalogo FROM inventario WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [venta.producto_id, empresaId]
      );
      if (!prodRows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El producto de esta venta ya no existe en inventario.' }); }
      producto = prodRows[0];
      precioCatalogo = Number(producto.precio_catalogo) || 0;
    }

    if (nuevoPrecio !== null) {
      const rangoPrecio = validarRangoPrecio(precioFinal, precioCatalogo);
      if (!rangoPrecio.ok) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({
          error: `El precio debe estar entre S/ ${rangoPrecio.min.toFixed(2)} y S/ ${rangoPrecio.max.toFixed(2)} (±30% del precio de catálogo: S/ ${precioCatalogo.toFixed(2)}).`
        });
      }
    }

    if (cantidadCambio) {
      const diferencia = nuevaCant - Number(venta.cantidad); // positivo = vende mas, negativo = devuelve
      if (diferencia > 0 && Number(producto.stock) < diferencia) {
        await cliente.query('ROLLBACK');
        return res.status(409).json({ error: `Stock insuficiente para aumentar la cantidad: solo quedan ${producto.stock} unidad(es) mas.` });
      }
      await cliente.query(`UPDATE inventario SET stock = stock - $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [diferencia, producto.id, empresaId]);
      cantidadFinal = nuevaCant;
    }

    const montoFinal = +(cantidadFinal * precioFinal).toFixed(2);
    if (montoFinal !== Number(venta.monto)) {
      await cliente.query(`UPDATE finanzas SET monto = $1, actualizado_el = now() WHERE origen_modulo='ventas' AND origen_id = $2 AND empresa_id = $3`, [montoFinal, venta.id, empresaId]);
      if (venta.cliente_id) {
        await cliente.query(`UPDATE clientes SET compras_totales = compras_totales + $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [montoFinal - Number(venta.monto), venta.cliente_id, empresaId]);
      }
    }

    const { rows: actualizada } = await cliente.query(
      `UPDATE ventas SET fecha = COALESCE($1, fecha), cantidad = $2, precio_unitario = $3, categoria = COALESCE($4, categoria),
       monto = $5, notas = COALESCE($6, notas), actualizado_el = now()
       WHERE id = $7 AND empresa_id = $8 RETURNING *`,
      [fecha || null, cantidadFinal, precioFinal, categoria || null, montoFinal, notas, venta.id, empresaId]
    );

    const cambios = {};
    if (Number(venta.cantidad) !== cantidadFinal) cambios.cantidad = { antes: Number(venta.cantidad), despues: cantidadFinal };
    if (Number(venta.precio_unitario) !== precioFinal) cambios.precio_unitario = { antes: Number(venta.precio_unitario), despues: precioFinal };
    if (categoria && categoria !== venta.categoria) cambios.categoria = { antes: venta.categoria, despues: categoria };
    if (fecha && fecha !== venta.fecha?.toISOString?.().slice(0, 10)) cambios.fecha = { antes: venta.fecha, despues: fecha };
    if (notas !== undefined && notas !== venta.notas) cambios.notas = { antes: venta.notas, despues: notas };

    const desviacion = nuevoPrecio !== null ? desviacionPrecio(precioFinal, precioCatalogo) : null;
    if (desviacion) cambios.desviacion_precio = desviacion;

    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'editar', modulo: 'ventas', registroId: venta.id,
      detalle: Object.keys(cambios).length ? cambios : 'Sin cambios en los valores (se guardó igual).'
    });
    await cliente.query('COMMIT');
    if (cantidadCambio) alertarProductoId = producto.id;
    res.json(actualizada[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la venta.' });
  } finally {
    cliente.release();
  }
  if (alertarProductoId) await alertarStockBajo(empresaId, [alertarProductoId]);
});

// DELETE /:id -- anular una venta devuelve el stock y borra su movimiento en finanzas.
router.delete('/:id', verificarPermiso('ventas.eliminar'), async (req, res) => {
  const empresaId = req.usuario.empresa_id;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Sub-fase D: mismo criterio que PUT -- va en el WHERE de la SELECT inicial.
    const { rows } = await cliente.query(
      `SELECT * FROM ventas WHERE id = $1 AND empresa_id = $2 AND ($3::int IS NULL OR sucursal_id = $3) FOR UPDATE`,
      [req.params.id, empresaId, req.sucursalRestringida ?? null]
    );
    if (!rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada.' }); }
    const venta = rows[0];

    if (venta.producto_id) {
      await cliente.query(`UPDATE inventario SET stock = stock + $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [venta.cantidad, venta.producto_id, empresaId]);
    }
    if (venta.cliente_id) {
      await cliente.query(`UPDATE clientes SET compras_totales = compras_totales - $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [venta.monto, venta.cliente_id, empresaId]);
    }
    await cliente.query(`DELETE FROM finanzas WHERE origen_modulo = 'ventas' AND origen_id = $1 AND empresa_id = $2`, [venta.id, empresaId]);
    await cliente.query(`DELETE FROM ventas WHERE id = $1 AND empresa_id = $2`, [venta.id, empresaId]);

    await registrarAuditoria(cliente, {
      usuario: req.usuario, accion: 'eliminar', modulo: 'ventas', registroId: venta.id,
      detalle: { eliminado: { producto: venta.producto, cliente: venta.cliente, cantidad: venta.cantidad, precio_unitario: venta.precio_unitario, monto: venta.monto }, stockDevuelto: venta.cantidad }
    });
    await cliente.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'No se pudo anular la venta.' });
  } finally {
    cliente.release();
  }
});

export default router;
