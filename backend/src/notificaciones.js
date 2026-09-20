// src/notificaciones.js
// Un solo lugar para crear notificaciones (paso 6 del backlog; tabla en la
// migración 044). Las usan dos cosas: el envío manual de mensajes
// (routes/notificaciones.js) y los avisos automáticos que disparan otras rutas
// (stock bajo al vender, arqueo con diferencia) o el barrido periódico (caja
// abierta demasiadas horas, productos por vencer).
//
// REGLA DE ORO: los avisos automáticos NUNCA deben tumbar la operación que los
// dispara. Por eso todo lo que se llama desde otra ruta (alertarStockBajo,
// alertarArqueo, revisarAlertasProgramadas) atrapa sus propios errores y solo
// los registra en consola -- igual que registrarAuditoria(). Y se llaman
// DESPUÉS del COMMIT y con el cliente ya liberado (nunca dentro de la
// transacción: un error de SQL adentro la abortaría entera, y con el pool de 10
// conexiones pedir una segunda mientras se sostiene la primera puede trabarlo).
// Efecto útil: si el código sale antes de correr la migración 044, ventas y
// cajas siguen funcionando; solo faltan los avisos.

import { pool } from './db.js';

export const HORAS_CAJA_ABIERTA = 12;
export const DIAS_AVISO_VENCIMIENTO = 7;
const DIAS_RETENCION = 90;
const MAX_LINEAS_RESUMEN = 6;

const numero = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cantidad = (v) => { const n = numero(v); return Number.isInteger(n) ? String(n) : n.toFixed(2); };
const soles = (v) => `S/ ${Math.abs(numero(v)).toFixed(2)}`;

// El público de GEALMI está en Perú: las horas de los avisos se escriben en su
// zona, no en la del servidor (UTC en Render).
function fechaHoraLima(fecha) {
  return new Date(fecha).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
}

// Inserta la misma notificación para varios destinatarios. Lanza si falla (el
// envío manual necesita enterarse); los avisos automáticos usan notificar().
// `clave` no nula = no repetir el mismo episodio: la fila que ya existe gana.
export async function insertarNotificaciones(db, {
  empresaId, usuarioIds, tipo, prioridad = 'normal', titulo, cuerpo = null, enlace = null,
  clave = null, remitente = null, lote = null
}) {
  const ids = [...new Set((usuarioIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO notificaciones (empresa_id, usuario_id, tipo, prioridad, titulo, cuerpo, enlace, remitente_id, remitente_nombre, lote, clave)
     SELECT $1::int, d.usuario_id, $2::varchar, $3::varchar, $4::varchar, $5::text, $6::varchar, $7::int, $8::varchar, $9::uuid, $10::varchar
     FROM unnest($11::int[]) AS d(usuario_id)
     ON CONFLICT (usuario_id, clave) WHERE clave IS NOT NULL DO NOTHING`,
    [empresaId, tipo, prioridad, titulo, cuerpo, enlace, remitente?.id ?? null, remitente?.nombre ?? null, lote, clave, ids]
  );
  return rowCount;
}

export async function notificar(db, datos) {
  try {
    return await insertarNotificaciones(db, datos);
  } catch (err) {
    console.error('No se pudo crear la notificación:', err.message);
    return 0;
  }
}

// Miembros ACTIVOS de la empresa cuyo rol tiene ese permiso. Con sucursalId,
// solo quienes trabajan en esa sucursal o no están atados a ninguna (el
// administrador que ve todo): a un cajero de otra sede no le toca el aviso.
export async function usuariosConPermiso(db, empresaId, permiso, { sucursalId = null, excluirUsuarioId = null } = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT ue.usuario_id AS id
     FROM usuario_empresa ue
     JOIN usuarios u ON u.id = ue.usuario_id
     JOIN rol_permiso rp ON rp.rol_id = ue.rol_id
     JOIN permisos p ON p.id = rp.permiso_id
     WHERE ue.empresa_id = $1 AND ue.activo = true AND u.activo = true AND p.nombre = $2
       AND ($3::int IS NULL OR ue.sucursal_id IS NULL OR ue.sucursal_id = $3)
       AND ($4::int IS NULL OR ue.usuario_id <> $4)`,
    [empresaId, permiso, sucursalId, excluirUsuarioId]
  );
  return rows.map(r => r.id);
}

// ---------------------------------------------------------------------------
// Avisos que dispara una operación (se llaman tras el COMMIT)
// ---------------------------------------------------------------------------

// Stock bajo: revisa los productos que se acaban de mover y avisa a quienes
// pueden reponer (inventario.editar). Solo productos con stock_minimo > 0: con
// 0 el negocio nunca fijó un mínimo y "stock <= 0" daría falsas alarmas. La
// clave lleva el día: varias ventas seguidas del mismo producto = un aviso, y
// si después llega a cero hay uno más fuerte ("Sin stock").
export async function alertarStockBajo(empresaId, productoIds) {
  try {
    const ids = [...new Set((productoIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return;
    const { rows } = await pool.query(
      `SELECT id, nombre, stock, stock_minimo, sucursal_id, CURRENT_DATE::text AS hoy
       FROM inventario
       WHERE empresa_id = $1 AND id = ANY($2::int[]) AND stock_minimo > 0 AND stock <= stock_minimo`,
      [empresaId, ids]
    );
    for (const p of rows) {
      const agotado = numero(p.stock) <= 0;
      const destinatarios = await usuariosConPermiso(pool, empresaId, 'inventario.editar', { sucursalId: p.sucursal_id });
      await insertarNotificaciones(pool, {
        empresaId, usuarioIds: destinatarios, tipo: 'stock_bajo', enlace: 'inventario',
        prioridad: agotado ? 'alta' : 'normal',
        titulo: agotado ? `Sin stock: ${p.nombre}` : `Stock bajo: ${p.nombre}`,
        cuerpo: agotado
          ? `Se agotó. El mínimo configurado es ${cantidad(p.stock_minimo)}.`
          : `Quedan ${cantidad(p.stock)} unidad(es); el mínimo configurado es ${cantidad(p.stock_minimo)}.`,
        clave: `${agotado ? 'stock_agotado' : 'stock_bajo'}:${p.id}:${p.hoy}`
      });
    }
  } catch (err) {
    console.error('No se pudo avisar el stock bajo:', err.message);
  }
}

// Arqueo con diferencia: al cerrar un turno, a quienes administran las cajas
// (cajas.crear: administrador y gerente), menos a quien acaba de cerrar -- ya
// vio el resultado en pantalla. Es "alta": queda como aviso hasta dar Enterado.
export async function alertarArqueo(empresaId, { turnoId, cajaNombre, sucursalId, diferencia, montoDeclarado, montoSistema }, actor) {
  try {
    if (Math.abs(numero(diferencia)) < 0.005) return;
    const destinatarios = await usuariosConPermiso(pool, empresaId, 'cajas.crear', { sucursalId, excluirUsuarioId: actor?.id ?? null });
    const sobrante = numero(diferencia) > 0;
    await insertarNotificaciones(pool, {
      empresaId, usuarioIds: destinatarios, tipo: 'arqueo_diferencia', prioridad: 'alta', enlace: 'cajas',
      titulo: `Arqueo con diferencia: ${cajaNombre}`,
      cuerpo: `${actor?.nombre || 'Alguien'} cerró el turno. Declaró ${soles(montoDeclarado)} y el sistema esperaba ${soles(montoSistema)}: ${sobrante ? 'sobran' : 'faltan'} ${soles(diferencia)}.`,
      clave: `arqueo:${turnoId}`
    });
  } catch (err) {
    console.error('No se pudo avisar el arqueo con diferencia:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Barrido periódico (cosas que no las dispara nadie: el tiempo pasa solo)
// ---------------------------------------------------------------------------
// No hay cron (Render gratis duerme al servicio): se corre desde la consulta
// de la campana (GET /api/notificaciones/resumen), como mucho una vez cada
// NOTIFICACIONES_REVISION_MIN minutos por empresa (10 por defecto). Si nadie
// está conectado no hay a quién avisarle, y en cuanto alguien entra corre.
const ultimaRevision = new Map(); // empresaId -> timestamp (ms)

export async function revisarAlertasProgramadas(empresaId) {
  const minutos = Number(process.env.NOTIFICACIONES_REVISION_MIN ?? 10);
  const ahora = Date.now();
  if (minutos > 0 && ahora - (ultimaRevision.get(empresaId) || 0) < minutos * 60000) return;
  ultimaRevision.set(empresaId, ahora); // antes de correr: dos peticiones a la vez no repiten el trabajo

  await avisarCajasAbiertas(empresaId);
  await avisarVencimientos(empresaId);
  await limpiarAntiguas(empresaId);
}

async function avisarCajasAbiertas(empresaId) {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.usuario_apertura_id, t.fecha_apertura, c.nombre AS caja, c.sucursal_id
       FROM turnos_caja t JOIN cajas c ON c.id = t.caja_id
       WHERE t.empresa_id = $1 AND t.estado = 'abierto' AND t.fecha_apertura < now() - make_interval(hours => $2)
       ORDER BY t.fecha_apertura LIMIT 50`,
      [empresaId, HORAS_CAJA_ABIERTA]
    );
    for (const t of rows) {
      const destinatarios = await usuariosConPermiso(pool, empresaId, 'cajas.crear', { sucursalId: t.sucursal_id });
      if (t.usuario_apertura_id) {
        // Quien la abrió también (si sigue siendo parte de la empresa): "revisa tu caja".
        const { rows: abre } = await pool.query(
          `SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2 AND activo = true`,
          [t.usuario_apertura_id, empresaId]
        );
        if (abre.length) destinatarios.push(t.usuario_apertura_id);
      }
      const horas = Math.floor((Date.now() - new Date(t.fecha_apertura).getTime()) / 3600000);
      await insertarNotificaciones(pool, {
        empresaId, usuarioIds: destinatarios, tipo: 'caja_abierta', prioridad: 'alta', enlace: 'cajas',
        titulo: `Caja abierta hace más de ${horas} horas: ${t.caja}`,
        cuerpo: `El turno se abrió el ${fechaHoraLima(t.fecha_apertura)} y sigue abierto. Revisa la caja y ciérrala con su arqueo.`,
        clave: `caja_abierta:${t.id}`
      });
    }
  } catch (err) {
    console.error('No se pudo revisar las cajas abiertas:', err.message);
  }
}

// Un solo aviso por sucursal y por día con TODO lo que vence pronto -- avisar
// producto por producto llenaría la campana de una empresa con muchos lotes.
async function avisarVencimientos(empresaId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, fecha_vencimiento::text AS vence, sucursal_id, CURRENT_DATE::text AS hoy
       FROM inventario
       WHERE empresa_id = $1 AND stock > 0
         AND fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int
       ORDER BY fecha_vencimiento, nombre LIMIT 300`,
      [empresaId, DIAS_AVISO_VENCIMIENTO]
    );
    const porSucursal = new Map();
    for (const p of rows) {
      if (!porSucursal.has(p.sucursal_id)) porSucursal.set(p.sucursal_id, []);
      porSucursal.get(p.sucursal_id).push(p);
    }
    for (const [sucursalId, productos] of porSucursal) {
      const destinatarios = await usuariosConPermiso(pool, empresaId, 'inventario.editar', { sucursalId });
      const lineas = productos.slice(0, MAX_LINEAS_RESUMEN).map(p => `• ${p.nombre} (vence el ${p.vence})`);
      if (productos.length > MAX_LINEAS_RESUMEN) lineas.push(`… y ${productos.length - MAX_LINEAS_RESUMEN} más`);
      await insertarNotificaciones(pool, {
        empresaId, usuarioIds: destinatarios, tipo: 'vencimientos', enlace: 'inventario',
        titulo: productos.length === 1
          ? `1 producto vence en los próximos ${DIAS_AVISO_VENCIMIENTO} días`
          : `${productos.length} productos vencen en los próximos ${DIAS_AVISO_VENCIMIENTO} días`,
        cuerpo: lineas.join('\n'),
        clave: `vencimientos:${productos[0].hoy}:${sucursalId}`
      });
    }
  } catch (err) {
    console.error('No se pudo revisar los vencimientos:', err.message);
  }
}

// La tabla no puede crecer sin límite: lo de hace más de 90 días ya no le
// sirve a nadie (lo importante quedó registrado en Auditoría).
async function limpiarAntiguas(empresaId) {
  try {
    await pool.query(
      `DELETE FROM notificaciones WHERE empresa_id = $1 AND creada_el < now() - make_interval(days => $2)`,
      [empresaId, DIAS_RETENCION]
    );
  } catch (err) {
    console.error('No se pudo limpiar las notificaciones antiguas:', err.message);
  }
}
