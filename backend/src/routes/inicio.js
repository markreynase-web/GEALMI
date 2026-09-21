// src/routes/inicio.js
// Resumen de la pantalla de Inicio, calculado en la base de datos.
//
// Antes, Inicio bajaba al navegador hasta 5 listados completos (ventas,
// inventario, clientes, finanzas y usuarios: hasta 5.000 filas cada uno) para
// sumar un puñado de números y mostrar cinco filas de cada lista. Con esto el
// navegador recibe solo esos números y esas filas: unos pocos KB en vez de
// megas, y una consulta agregada por sección en vez de leer tablas enteras.
//
// Las reglas de acceso son las MISMAS que las de los listados originales:
//   * cada sección exige su permiso (ventas.ver, inventario.ver...) Y que la
//     empresa tenga ese módulo contratado (lo que hace requireModulo);
//   * la membresía del usuario tiene que seguir activa (salvo sesiones de soporte);
//   * un usuario atado a una sucursal solo ve las cifras de SU sucursal en
//     ventas, inventario y finanzas (req.sucursalRestringida).
// Una sección que la sesión no puede ver simplemente no viene en la respuesta.
//
// Los números salen de TODAS las filas (el listado anterior traía solo las 5.000
// más recientes, así que "histórico" y "top productos" se quedaban cortos en una
// empresa con mucho movimiento).

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { resolverRestriccionSucursal } from '../middleware/sucursal.js';
import { ErrorValidacion, responderError, validar, hoyLima, tienePermiso } from '../validacion.js';

const router = Router();
router.use(auth, requireEmpresa, resolverRestriccionSucursal);

const MODULOS_DE_INICIO = ['ventas', 'inventario', 'clientes', 'finanzas'];
const MODOS_SERIE = ['anio', '30d', '6m', 'personalizado'];
const MAX_DIAS_PERSONALIZADO = 1830; // 5 años

// Qué secciones puede ver ESTA sesión. Lanza 403 si su membresía ya no está activa.
async function seccionesVisibles(req) {
  const empresaId = req.usuario.empresa_id;
  if (req.usuario.impersonando !== true) {
    const { rows } = await pool.query(
      `SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2 AND activo = true`,
      [req.usuario.id, empresaId]
    );
    if (!rows.length) throw new ErrorValidacion('Tu acceso a esta empresa ya no está activo.', 403);
  }
  const { rows: modulos } = await pool.query(
    `SELECT modulo_id FROM empresa_modulos WHERE empresa_id = $1 AND modulo_id = ANY($2::text[])`,
    [empresaId, MODULOS_DE_INICIO]
  );
  const contratados = new Set(modulos.map(m => m.modulo_id));
  const puede = (modulo) => contratados.has(modulo) && tienePermiso(req, `${modulo}.ver`);
  return {
    ventas: puede('ventas'), inventario: puede('inventario'), clientes: puede('clientes'), finanzas: puede('finanzas'),
    usuarios: tienePermiso(req, 'usuarios.ver') // Usuarios no es un módulo contratable
  };
}

// 'AAAA-MM-01' del mes que corresponde a hoy, desplazado `meses` (0 = este mes, -1 = el anterior...).
function primerDiaDelMes(hoy, meses = 0) {
  const [anio, mes] = hoy.split('-').map(Number);
  return new Date(Date.UTC(anio, mes - 1 + meses, 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Series de finanzas (el gráfico de ingresos y egresos)
// ---------------------------------------------------------------------------

// Devuelve puntos { clave, ingresos, egresos } agrupados por día ('AAAA-MM-DD') o por
// mes ('AAAA-MM'); el navegador se encarga de las etiquetas y de rellenar los meses vacíos.
async function serieFinanzas(empresaId, sucursal, { modo, desde, hasta }, hoy) {
  let condicion, parametros, granularidad;
  if (modo === '30d') {
    condicion = 'fecha >= $3::date - 30'; parametros = [hoy]; granularidad = 'dia';
  } else if (modo === '6m') {
    condicion = `fecha >= $3::date - interval '6 months'`; parametros = [hoy]; granularidad = 'mes';
  } else if (modo === 'personalizado') {
    condicion = 'fecha BETWEEN $3::date AND $4::date'; parametros = [desde, hasta];
    granularidad = (new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000 > 45 ? 'mes' : 'dia';
  } else { // 'anio': el año en curso, mes a mes
    condicion = 'fecha >= $3::date AND fecha < $4::date';
    parametros = [primerDiaDelMes(hoy, -(Number(hoy.slice(5, 7)) - 1)), primerDiaDelMes(hoy, 13 - Number(hoy.slice(5, 7)))];
    granularidad = 'mes';
  }
  // El formato sale de una constante propia (nunca del cliente): seguro de interpolar.
  const formato = granularidad === 'dia' ? 'YYYY-MM-DD' : 'YYYY-MM';
  const { rows } = await pool.query(
    `SELECT to_char(fecha, '${formato}') AS clave,
            COALESCE(sum(monto) FILTER (WHERE tipo = 'ingreso'), 0)::float8 AS ingresos,
            COALESCE(sum(monto) FILTER (WHERE tipo = 'egreso'), 0)::float8 AS egresos
     FROM finanzas
     WHERE empresa_id = $1 AND ($2::int IS NULL OR sucursal_id = $2) AND ${condicion}
     GROUP BY 1 ORDER BY 1`,
    [empresaId, sucursal, ...parametros]
  );
  return { modo, granularidad, puntos: rows };
}

// ---------------------------------------------------------------------------
// GET /resumen
// ---------------------------------------------------------------------------

router.get('/resumen', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const sucursal = req.sucursalRestringida ?? null;
    const visibles = await seccionesVisibles(req);
    const hoy = hoyLima();
    const inicioMes = primerDiaDelMes(hoy), inicioMesSiguiente = primerDiaDelMes(hoy, 1), inicioMesAnterior = primerDiaDelMes(hoy, -1);
    const respuesta = {};

    // Consultas EN SERIE, no en paralelo: el pool es de 10 conexiones y esta es la pantalla que
    // más gente abre; cada una es corta y usa índices por empresa.
    if (visibles.ventas) {
      const { rows: [tot] } = await pool.query(
        `SELECT COALESCE(sum(monto) FILTER (WHERE fecha >= $2 AND fecha < $3), 0)::float8 AS total_mes,
                (count(*) FILTER (WHERE fecha >= $2 AND fecha < $3))::int AS cantidad_mes,
                COALESCE(sum(monto), 0)::float8 AS total_historico,
                COALESCE(sum(monto) FILTER (WHERE fecha >= $4 AND fecha < $2), 0)::float8 AS total_mes_anterior
         FROM ventas WHERE empresa_id = $1 AND ($5::int IS NULL OR sucursal_id = $5)`,
        [empresaId, inicioMes, inicioMesSiguiente, inicioMesAnterior, sucursal]
      );
      const { rows: top } = await pool.query(
        `SELECT COALESCE(NULLIF(btrim(producto), ''), 'Sin dato') AS nombre, sum(monto)::float8 AS monto
         FROM ventas WHERE empresa_id = $1 AND ($2::int IS NULL OR sucursal_id = $2)
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
        [empresaId, sucursal]
      );
      respuesta.ventas = { ...tot, top_productos: top };
    }

    if (visibles.inventario) {
      const filtro = 'empresa_id = $1 AND ($2::int IS NULL OR sucursal_id = $2)';
      const { rows: [tot] } = await pool.query(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE stock <= stock_minimo))::int AS alertas_total FROM inventario WHERE ${filtro}`,
        [empresaId, sucursal]
      );
      // Lo más agotado primero: antes salían "los más recientes", que no eran los más urgentes.
      const { rows: alertas } = await pool.query(
        `SELECT id, nombre, stock::float8 AS stock, stock_minimo::float8 AS stock_minimo FROM inventario
         WHERE ${filtro} AND stock <= stock_minimo ORDER BY stock ASC, nombre, id LIMIT 8`,
        [empresaId, sucursal]
      );
      // Ventana de -30 a +30 días: lo que vence pronto y lo que venció hace poco (todavía accionable).
      const { rows: vencimientos } = await pool.query(
        `SELECT id, nombre, fecha_vencimiento::text AS fecha_vencimiento, (fecha_vencimiento - $3::date)::int AS dias
         FROM inventario WHERE ${filtro} AND fecha_vencimiento BETWEEN $3::date - 30 AND $3::date + 30
         ORDER BY fecha_vencimiento, nombre, id LIMIT 8`,
        [empresaId, sucursal, hoy]
      );
      respuesta.inventario = { ...tot, alertas, vencimientos };
    }

    if (visibles.clientes) {
      const { rows: [tot] } = await pool.query(`SELECT count(*)::int AS total FROM clientes WHERE empresa_id = $1`, [empresaId]);
      const { rows: top } = await pool.query(
        `SELECT nombre, compras_totales::float8 AS compras_totales FROM clientes WHERE empresa_id = $1
         ORDER BY compras_totales DESC, id LIMIT 5`,
        [empresaId]
      );
      respuesta.clientes = { total: tot.total, top };
    }

    if (visibles.finanzas) {
      const { rows: [tot] } = await pool.query(
        `SELECT COALESCE(sum(monto) FILTER (WHERE tipo = 'ingreso'), 0)::float8 AS ingresos,
                COALESCE(sum(monto) FILTER (WHERE tipo = 'egreso'), 0)::float8 AS egresos,
                COALESCE(sum(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END) FILTER (WHERE fecha >= $2 AND fecha < $3), 0)::float8 AS neto_mes,
                COALESCE(sum(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END) FILTER (WHERE fecha >= $4 AND fecha < $2), 0)::float8 AS neto_mes_anterior
         FROM finanzas WHERE empresa_id = $1 AND ($5::int IS NULL OR sucursal_id = $5)`,
        [empresaId, inicioMes, inicioMesSiguiente, inicioMesAnterior, sucursal]
      );
      // El gráfico arranca en "Este año": va en la misma respuesta para no hacer una petición más.
      respuesta.finanzas = { ...tot, serie: await serieFinanzas(empresaId, sucursal, { modo: 'anio' }, hoy) };
    }

    if (visibles.usuarios) {
      const { rows: [tot] } = await pool.query(
        `SELECT (count(*) FILTER (WHERE activo))::int AS activos, count(*)::int AS total FROM usuario_empresa WHERE empresa_id = $1`,
        [empresaId]
      );
      respuesta.usuarios = tot;
    }

    res.json({ hoy, sucursal_restringida: sucursal !== null, ...respuesta });
  } catch (err) {
    responderError(res, err, 'No se pudo armar el resumen de Inicio.');
  }
});

// ---------------------------------------------------------------------------
// GET /finanzas-serie?modo=anio|30d|6m|personalizado&desde=&hasta=
// (al cambiar el período del gráfico; consulta chica, solo lo que se dibuja)
// ---------------------------------------------------------------------------

router.get('/finanzas-serie', async (req, res) => {
  try {
    const visibles = await seccionesVisibles(req);
    if (!visibles.finanzas) throw new ErrorValidacion('No tienes permiso para esto (finanzas.ver).', 403);
    const modo = validar.enumerado(req.query.modo || null, 'modo', MODOS_SERIE, { porDefecto: 'anio' });
    let desde = null, hasta = null;
    if (modo === 'personalizado') {
      desde = validar.fecha(req.query.desde, 'desde', { requerido: true });
      hasta = validar.fecha(req.query.hasta, 'hasta', { requerido: true });
      if (hasta < desde) throw new ErrorValidacion('"hasta" no puede ser anterior a "desde".');
      if ((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000 > MAX_DIAS_PERSONALIZADO) {
        throw new ErrorValidacion('El rango no puede pasar de 5 años.');
      }
    }
    res.json(await serieFinanzas(req.usuario.empresa_id, req.sucursalRestringida ?? null, { modo, desde, hasta }, hoyLima()));
  } catch (err) {
    responderError(res, err, 'No se pudo armar la serie de finanzas.');
  }
});

export default router;
