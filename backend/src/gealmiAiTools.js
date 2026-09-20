// src/gealmiAiTools.js
// Fase D: "herramientas de datos" que GEALMI AI (Claude, vía tool use) puede
// llamar para responder preguntas y armar reportes con cifras reales de la
// empresa activa -- Claude nunca escribe SQL, cada herramienta es una
// consulta parametrizada fija (mismo patrón de pool.query(sql, [empresa_id,
// ...]) que ya usa cada ruta del backend), scoped siempre a empresaId.
//
// construirHerramientas() arma el set de tools disponible según qué módulos
// tiene habilitados la empresa (empresa_modulos) -- si no tiene Repuestos,
// Claude ni ve esa parte de las herramientas, para que no alucine datos de
// un vertical que esa empresa no usa.

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// La mayoría de "resúmenes" sin fechas explícitas usan los últimos 30 días
// (no el historial completo) -- mismo criterio que las Vistas Ejecutivas del
// resto de la app, que siempre trabajan sobre un rango. Se devuelve el rango
// resuelto junto con los datos para que Claude sepa exactamente qué período
// está describiendo (nunca debe asumirlo).
function rangoPorDefecto(desde, hasta) {
  const hastaFinal = hasta || hoyISO();
  let desdeFinal = desde;
  if (!desdeFinal) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    desdeFinal = d.toISOString().slice(0, 10);
  }
  return { desde: desdeFinal, hasta: hastaFinal };
}

function clamp(valor, porDefecto, min, max) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function resumenVentas({ pool, empresaId }, input = {}) {
  const { desde, hasta } = rangoPorDefecto(input.desde, input.hasta);
  const totales = await pool.query(
    `SELECT COUNT(*)::int AS cantidad_ventas,
            COALESCE(SUM(monto),0)::float AS total_monto,
            COALESCE(AVG(monto),0)::float AS ticket_promedio
     FROM ventas WHERE empresa_id = $1 AND fecha >= $2 AND fecha <= $3`,
    [empresaId, desde, hasta]
  );
  const topProductos = await pool.query(
    `SELECT producto, COUNT(*)::int AS ventas, COALESCE(SUM(monto),0)::float AS total
     FROM ventas WHERE empresa_id = $1 AND fecha >= $2 AND fecha <= $3
     GROUP BY producto ORDER BY total DESC LIMIT 5`,
    [empresaId, desde, hasta]
  );
  return { desde, hasta, ...totales.rows[0], top_productos: topProductos.rows };
}

async function tendenciaVentasMensual({ pool, empresaId }, input = {}) {
  const meses = clamp(input.meses, 6, 1, 24);
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes,
            COUNT(*)::int AS cantidad_ventas,
            COALESCE(SUM(monto),0)::float AS total_monto
     FROM ventas
     WHERE empresa_id = $1 AND fecha >= (CURRENT_DATE - ($2 || ' months')::interval)
     GROUP BY 1 ORDER BY 1`,
    [empresaId, meses]
  );
  return { meses_solicitados: meses, serie_mensual: rows };
}

async function alertasStock({ pool, empresaId, modulosHabilitados, puede }) {
  const inventario = await pool.query(
    `SELECT nombre, categoria, stock, stock_minimo
     FROM inventario WHERE empresa_id = $1 AND stock <= stock_minimo
     ORDER BY (stock - stock_minimo) ASC LIMIT 50`,
    [empresaId]
  );
  const resultado = { inventario: inventario.rows };
  if (modulosHabilitados.has('repuestos') && puede('repuestos.ver')) {
    const repuestos = await pool.query(
      `SELECT nombre, codigo_oem, stock, stock_minimo
       FROM repuestos WHERE empresa_id = $1 AND stock <= stock_minimo
       ORDER BY (stock - stock_minimo) ASC LIMIT 50`,
      [empresaId]
    );
    resultado.repuestos = repuestos.rows;
  }
  return resultado;
}

async function productosBajaRotacion({ pool, empresaId }, input = {}) {
  const dias = clamp(input.dias, 60, 7, 365);
  const { rows } = await pool.query(
    `SELECT i.nombre, i.categoria, i.stock
     FROM inventario i
     WHERE i.empresa_id = $1 AND i.stock > 0
       AND NOT EXISTS (
         SELECT 1 FROM ventas v
         WHERE v.producto_id = i.id AND v.empresa_id = $1
           AND v.fecha >= CURRENT_DATE - ($2 || ' days')::interval
       )
     ORDER BY i.stock DESC LIMIT 50`,
    [empresaId, dias]
  );
  return { dias_sin_venta: dias, productos: rows };
}

async function velocidadDeVentaDeProducto({ pool, empresaId, modulosHabilitados, puede }, input = {}) {
  const nombre = (input.nombre || '').trim();
  if (!nombre) return { error: 'Falta el nombre (o parte del nombre) del producto o repuesto a buscar.' };

  const resultados = [];

  const inv = await pool.query(
    `SELECT id, nombre, stock, stock_minimo FROM inventario
     WHERE empresa_id = $1 AND nombre ILIKE '%' || $2 || '%' ORDER BY nombre LIMIT 5`,
    [empresaId, nombre]
  );
  for (const p of inv.rows) {
    const vel = await pool.query(
      `SELECT COALESCE(SUM(cantidad),0)::float AS unidades FROM ventas
       WHERE empresa_id = $1 AND producto_id = $2 AND fecha >= CURRENT_DATE - INTERVAL '30 days'`,
      [empresaId, p.id]
    );
    const unidades30d = vel.rows[0].unidades;
    const ritmoDiario = unidades30d / 30;
    resultados.push({
      tipo: 'inventario',
      producto: p.nombre,
      stock_actual: Number(p.stock),
      stock_minimo: Number(p.stock_minimo),
      unidades_vendidas_ultimos_30_dias: unidades30d,
      ritmo_diario_estimado: Number(ritmoDiario.toFixed(2)),
      dias_restantes_estimados: ritmoDiario > 0 ? Math.round(p.stock / ritmoDiario) : null
    });
  }

  if (modulosHabilitados.has('repuestos') && puede('repuestos.ver')) {
    const rep = await pool.query(
      `SELECT id, nombre, stock, stock_minimo FROM repuestos
       WHERE empresa_id = $1 AND nombre ILIKE '%' || $2 || '%' ORDER BY nombre LIMIT 5`,
      [empresaId, nombre]
    );
    for (const p of rep.rows) {
      const vel = await pool.query(
        `SELECT COALESCE(SUM(cantidad_repuesto),0)::float AS unidades FROM postventa
         WHERE empresa_id = $1 AND repuesto_id = $2 AND fecha >= CURRENT_DATE - INTERVAL '30 days'`,
        [empresaId, p.id]
      );
      const unidades30d = vel.rows[0].unidades;
      const ritmoDiario = unidades30d / 30;
      resultados.push({
        tipo: 'repuesto',
        producto: p.nombre,
        stock_actual: Number(p.stock),
        stock_minimo: Number(p.stock_minimo),
        unidades_vendidas_ultimos_30_dias: unidades30d,
        ritmo_diario_estimado: Number(ritmoDiario.toFixed(2)),
        dias_restantes_estimados: ritmoDiario > 0 ? Math.round(p.stock / ritmoDiario) : null
      });
    }
  }

  if (!resultados.length) return { encontrado: false, busqueda: nombre };
  return { encontrado: true, resultados };
}

async function resumenFinanzas({ pool, empresaId }, input = {}) {
  const { desde, hasta } = rangoPorDefecto(input.desde, input.hasta);
  const porTipo = await pool.query(
    `SELECT tipo, COALESCE(SUM(monto),0)::float AS total
     FROM finanzas WHERE empresa_id = $1 AND fecha >= $2 AND fecha <= $3
     GROUP BY tipo`,
    [empresaId, desde, hasta]
  );
  const porCategoria = await pool.query(
    `SELECT tipo, categoria, COALESCE(SUM(monto),0)::float AS total
     FROM finanzas WHERE empresa_id = $1 AND fecha >= $2 AND fecha <= $3
     GROUP BY tipo, categoria ORDER BY total DESC LIMIT 10`,
    [empresaId, desde, hasta]
  );
  const ingresos = porTipo.rows.find(r => r.tipo === 'ingreso')?.total || 0;
  const egresos = porTipo.rows.find(r => r.tipo === 'egreso')?.total || 0;
  return { desde, hasta, ingresos, egresos, saldo_neto: ingresos - egresos, por_categoria: porCategoria.rows };
}

async function topClientes({ pool, empresaId }, input = {}) {
  const { desde, hasta } = rangoPorDefecto(input.desde, input.hasta);
  const limite = clamp(input.limite, 5, 1, 20);
  const { rows } = await pool.query(
    `SELECT c.nombre, COUNT(v.id)::int AS compras, COALESCE(SUM(v.monto),0)::float AS total
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id
     WHERE v.empresa_id = $1 AND v.fecha >= $2 AND v.fecha <= $3
     GROUP BY c.nombre ORDER BY total DESC LIMIT $4`,
    [empresaId, desde, hasta, limite]
  );
  return { desde, hasta, clientes: rows };
}

async function detectarAnomaliasVentas({ pool, empresaId }, input = {}) {
  const dias = clamp(input.dias, 30, 7, 180);
  const { rows } = await pool.query(
    `WITH diario AS (
       SELECT fecha, SUM(monto)::float AS total
       FROM ventas WHERE empresa_id = $1 AND fecha >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY fecha
     ), stats AS (
       SELECT AVG(total) AS media, STDDEV_POP(total) AS desviacion, COUNT(*)::int AS dias_con_datos FROM diario
     )
     SELECT d.fecha, d.total, s.media, s.desviacion, s.dias_con_datos
     FROM diario d, stats s
     WHERE s.desviacion > 0 AND ABS(d.total - s.media) > 2 * s.desviacion
     ORDER BY d.fecha DESC`,
    [empresaId, dias]
  );
  if (!rows.length) return { dias_analizados: dias, anomalias: [], nota: 'Sin días fuera de lo normal, o muy pocos datos para calcularlo con confianza.' };
  const { media, desviacion, dias_con_datos } = rows[0];
  return {
    dias_analizados: dias,
    dias_con_datos,
    promedio_diario: media,
    desviacion_estandar: desviacion,
    anomalias: rows.map(r => ({ fecha: r.fecha, total: r.total }))
  };
}

// Definición de cada herramienta en formato Claude tool-use, junto con su
// implementación. `requiereModulo`: si está presente, la tool solo se ofrece
// cuando ese módulo está habilitado para la empresa (además de las que
// siempre están disponibles porque leen tablas núcleo desde Fase A).
const CATALOGO = [
  {
    name: 'resumen_ventas',
    description: 'Resumen de ventas en un rango de fechas: cantidad de ventas, monto total, ticket promedio y los 5 productos con más ingresos. Si no se dan fechas, usa los últimos 30 días. Para comparar dos períodos (ej. "este mes vs el anterior"), llama esta herramienta dos veces con rangos distintos.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha de inicio, formato YYYY-MM-DD (opcional).' },
        hasta: { type: 'string', description: 'Fecha de fin, formato YYYY-MM-DD (opcional).' }
      }
    },
    permisos: ['ventas.ver'],
    ejecutar: resumenVentas
  },
  {
    name: 'tendencia_ventas_mensual',
    description: 'Serie de ventas mes a mes (cantidad y monto total) de los últimos N meses. Útil para describir tendencia o estacionalidad y para estimar hacia dónde van las ventas -- razona sobre la serie, no hay un modelo de predicción aparte.',
    input_schema: {
      type: 'object',
      properties: { meses: { type: 'integer', description: 'Cuántos meses hacia atrás (1-24). Por defecto 6.' } }
    },
    permisos: ['ventas.ver'],
    ejecutar: tendenciaVentasMensual
  },
  {
    name: 'alertas_stock',
    description: 'Productos (y repuestos, si ese módulo está habilitado) cuyo stock actual está en o por debajo de su stock mínimo -- candidatos a reponer ya.',
    input_schema: { type: 'object', properties: {} },
    permisos: ['inventario.ver'],
    ejecutar: alertasStock
  },
  {
    name: 'productos_baja_rotacion',
    description: 'Productos de inventario con stock disponible que no han tenido ninguna venta en los últimos N días -- candidatos a promoción, descuento o dejar de reabastecer.',
    input_schema: {
      type: 'object',
      properties: { dias: { type: 'integer', description: 'Días sin venta para considerarlo de baja rotación (7-365). Por defecto 60.' } }
    },
    permisos: ['inventario.ver'],
    ejecutar: productosBajaRotacion
  },
  {
    name: 'velocidad_de_venta_de_producto',
    description: 'Busca un producto (o repuesto) por nombre y calcula su ritmo de venta de los últimos 30 días y en cuántos días se agotaría el stock actual a ese ritmo -- la base para recomendar cuándo y cuánto comprar.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string', description: 'Nombre o parte del nombre del producto/repuesto a buscar.' } },
      required: ['nombre']
    },
    permisos: ['inventario.ver'],
    ejecutar: velocidadDeVentaDeProducto
  },
  {
    name: 'resumen_finanzas',
    description: 'Ingresos vs egresos en un rango de fechas, saldo neto, y desglose por categoría. Si no se dan fechas, usa los últimos 30 días.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha de inicio, formato YYYY-MM-DD (opcional).' },
        hasta: { type: 'string', description: 'Fecha de fin, formato YYYY-MM-DD (opcional).' }
      }
    },
    permisos: ['finanzas.ver'],
    ejecutar: resumenFinanzas
  },
  {
    name: 'top_clientes',
    description: 'Mejores clientes por monto comprado en un rango de fechas. Si no se dan fechas, usa los últimos 30 días.',
    input_schema: {
      type: 'object',
      properties: {
        limite: { type: 'integer', description: 'Cuántos clientes devolver (1-20). Por defecto 5.' },
        desde: { type: 'string', description: 'Fecha de inicio, formato YYYY-MM-DD (opcional).' },
        hasta: { type: 'string', description: 'Fecha de fin, formato YYYY-MM-DD (opcional).' }
      }
    },
    permisos: ['ventas.ver', 'clientes.ver'],
    ejecutar: topClientes
  },
  {
    name: 'detectar_anomalias_ventas',
    description: 'Revisa las ventas diarias de los últimos N días y señala los días cuyo monto se sale claramente de lo normal (más de 2 desviaciones estándar de la media) -- picos o caídas atípicas que vale la pena investigar.',
    input_schema: {
      type: 'object',
      properties: { dias: { type: 'integer', description: 'Cuántos días hacia atrás analizar (7-180). Por defecto 30.' } }
    },
    permisos: ['ventas.ver'],
    ejecutar: detectarAnomaliasVentas
  }
];

// permisos: los del usuario que pregunta (los del JWT). La IA nunca debe darle a
// alguien datos que su rol no puede ver en la app: cada herramienta declara los
// permisos que exige y las que no se cumplen ni se le OFRECEN al modelo (así ni
// sabe que existen). Sin `permisos` (llamada interna sin usuario) no se filtra.
export function construirHerramientas({ pool, empresaId, modulosHabilitados, permisos }) {
  const puede = (permiso) => !Array.isArray(permisos) || permisos.includes(permiso);
  const ctx = { pool, empresaId, modulosHabilitados, puede };
  return CATALOGO
    .filter(({ permisos: exigidos }) => exigidos.every(puede))
    .map(({ name, description, input_schema, ejecutar }) => ({
      name,
      description,
      input_schema,
      ejecutar: (input) => ejecutar(ctx, input)
    }));
}
