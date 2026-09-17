// src/routes/publicApi.js
// API pública de solo lectura (Nivel 3 del roadmap: "Exportación de datos +
// API"). Montada aparte de /api/* (el API interno que usa el propio
// frontend) bajo /api/v1/* -- dos superficies separadas a propósito: el
// API interno puede cambiar de forma libre porque solo lo consume nuestro
// propio frontend (ambos se despliegan juntos); el API pública es un
// CONTRATO con integraciones de terceros que no controlamos, así que
// necesita su propio espacio para versionar sin arriesgar romper /api/*.
//
// Autenticación: authApiKey (ver middleware/apiKeyAuth.js), nunca el JWT de
// sesión. Solo GET -- ver la decisión explícita de dejar esta v1 de solo
// lectura (escritura queda para una sub-fase futura, si hace falta).
//
// Siempre paginado (a diferencia de crudFactory.js, que responde un array
// plano por default por compatibilidad con el frontend interno que ya
// existía antes de la paginación) -- acá no hay nada legacy que preservar,
// así que el contrato queda limpio y predecible desde el día uno: toda
// respuesta de listado es siempre { datos, meta }.

import { Router } from 'express';
import { pool } from '../db.js';
import { authApiKey } from '../middleware/apiKeyAuth.js';

const router = Router();
router.use(authApiKey);

/**
 * @param {object} config
 * @param {string} config.tabla - nombre de la tabla en PostgreSQL
 * @param {string} [config.columnaFecha] - columna para ?desde=&hasta= (default 'fecha')
 * @param {string[]} [config.columnasFiltroExacto] - columnas que aceptan filtro exacto ?columna=valor (ej. ['sucursal_id'])
 */
function crearRouterSoloLectura({ tabla, columnaFecha = 'fecha', columnasFiltroExacto = [] }) {
  const sub = Router();

  sub.get('/', async (req, res) => {
    const { desde, hasta, pagina, page, limite } = req.query;
    const valores = [req.empresaId];
    const condiciones = ['empresa_id = $1'];
    if (desde) { valores.push(desde); condiciones.push(`${columnaFecha} >= $${valores.length}`); }
    if (hasta) { valores.push(hasta); condiciones.push(`${columnaFecha} <= $${valores.length}`); }
    columnasFiltroExacto.forEach(c => {
      const v = req.query[c];
      if (v !== undefined && v !== '') { valores.push(v); condiciones.push(`${c} = $${valores.length}`); }
    });
    const where = `WHERE ${condiciones.join(' AND ')}`;

    const paginaFinal = Math.max(parseInt(pagina ?? page, 10) || 1, 1);
    const limiteFinal = Math.min(Math.max(parseInt(limite, 10) || 100, 1), 500);
    const offset = (paginaFinal - 1) * limiteFinal;

    try {
      const [{ rows: datos }, { rows: totalRows }] = await Promise.all([
        pool.query(
          `SELECT * FROM ${tabla} ${where} ORDER BY ${columnaFecha} DESC, id DESC LIMIT ${limiteFinal} OFFSET ${offset}`,
          valores
        ),
        pool.query(`SELECT count(*)::int AS total FROM ${tabla} ${where}`, valores)
      ]);
      const total = totalRows[0].total;
      res.json({ datos, meta: { total, pagina: paginaFinal, limite: limiteFinal, paginasTotales: Math.ceil(total / limiteFinal) || 0 } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `No se pudieron leer los registros de ${tabla}.` });
    }
  });

  sub.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${tabla} WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.empresaId]);
      if (!rows.length) return res.status(404).json({ error: 'Registro no encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `No se pudo leer el registro de ${tabla}.` });
    }
  });

  return sub;
}

router.use('/ventas', crearRouterSoloLectura({ tabla: 'ventas', columnasFiltroExacto: ['sucursal_id'] }));
router.use('/inventario', crearRouterSoloLectura({ tabla: 'inventario', columnaFecha: 'fecha_registro', columnasFiltroExacto: ['sucursal_id'] }));
router.use('/clientes', crearRouterSoloLectura({ tabla: 'clientes', columnaFecha: 'fecha_registro' }));
router.use('/finanzas', crearRouterSoloLectura({ tabla: 'finanzas', columnasFiltroExacto: ['sucursal_id'] }));

export default router;
