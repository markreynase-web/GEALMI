// src/salud.js
// Comprobación de salud CON base de datos (GET /api/salud/db), pensada para un
// monitor externo (UptimeRobot o similar). Sirve para tres cosas a la vez:
//   * mantener despierto al backend (Render gratis se apaga a los 15 min sin tráfico);
//   * hacer una consulta real cada pocos minutos (actividad de base de datos);
//   * avisar por correo si el backend O la base dejan de responder.
//
// /api/salud (server.js) se queda como está: responde sin tocar la base, y el
// frontend y Render lo usan solo para saber si el proceso está vivo.
//
// Protección: el resultado se guarda unos segundos y una comprobación en curso
// se comparte. Así, aunque alguien golpee este endpoint público sin parar, la
// base recibe como mucho una consulta cada CACHE_OK_MS -- no puede agotar el
// pool de 10 conexiones que usa el resto de la aplicación.

import { pool } from './db.js';

const TIEMPO_MAXIMO_MS = 4000;
const CACHE_OK_MS = 10000;
const CACHE_ERROR_MS = 3000; // un fallo se reintenta antes: al recuperarse la base, el monitor lo ve pronto

let ultimo = { en: 0, ok: false, ms: null };
let enCurso = null;

export async function estadoBaseDeDatos() {
  const ahora = Date.now();
  const vigencia = ultimo.ok ? CACHE_OK_MS : CACHE_ERROR_MS;
  if (ahora - ultimo.en < vigencia) return ultimo;
  if (enCurso) return enCurso; // varias peticiones a la vez comparten UNA consulta

  enCurso = (async () => {
    const inicio = Date.now();
    let temporizador;
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, rechazar) => { temporizador = setTimeout(() => rechazar(new Error('tiempo agotado')), TIEMPO_MAXIMO_MS); })
      ]);
      ultimo = { en: Date.now(), ok: true, ms: Date.now() - inicio };
    } catch (err) {
      console.error('Salud: la base de datos no respondió:', err.message);
      ultimo = { en: Date.now(), ok: false, ms: null };
    } finally {
      clearTimeout(temporizador);
      enCurso = null;
    }
    return ultimo;
  })();
  return enCurso;
}

// Handler de Express. 200 si la base responde; 503 si no (los monitores lo
// toman como "caído"). Nunca devuelve el detalle del error: es una ruta pública.
export async function responderSaludDb(req, res) {
  const estado = await estadoBaseDeDatos();
  res.set('Cache-Control', 'no-store');
  if (estado.ok) return res.json({ ok: true, base_de_datos: 'ok', respuesta_ms: estado.ms });
  return res.status(503).json({ ok: false, base_de_datos: 'sin_respuesta' });
}
