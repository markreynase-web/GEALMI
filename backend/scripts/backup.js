#!/usr/bin/env node
// scripts/backup.js
// Backup lógico real de PostgreSQL vía pg_dump, formato -Fc (custom,
// comprimido, restaurable con pg_restore -- ver scripts/restore.js y
// BACKUP.md para el procedimiento completo).
//
// La contraseña nunca se pasa como argumento de línea de comandos (quedaría
// visible en la lista de procesos del sistema operativo) -- la URL de
// origen se parsea acá y sus partes se pasan a pg_dump como variables de
// entorno libpq (PGHOST/PGUSER/PGPASSWORD/...), que es como pg_dump las lee
// de todas formas.
//
// Origen del backup, en orden de preferencia:
//   1. BACKUP_DATABASE_URL -- override explícito (pensado para backups de
//      un entorno puntual, ej. la base de testing de Fase 1, sin tener que
//      sobrescribir DATABASE_URL a mano en cada invocación).
//   2. DATABASE_URL -- comportamiento normal/futuro del script (respaldar
//      la base "de siempre", típicamente producción).
// Si se definen AMBAS y son idénticas, el script aborta: no tiene sentido
// setear un override que apunta al mismo lugar, y en la práctica suele
// significar que se pegó la URL equivocada en BACKUP_DATABASE_URL.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function fallar(mensaje) {
  console.error(`[backup] ${mensaje}`);
  process.exit(1);
}

const usaOverride = Boolean(process.env.BACKUP_DATABASE_URL);
const origenUrlTexto = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;

if (!origenUrlTexto) {
  fallar('Falta BACKUP_DATABASE_URL o DATABASE_URL. No se puede hacer backup sin saber a qué base conectarse.');
}

if (usaOverride && process.env.DATABASE_URL && process.env.BACKUP_DATABASE_URL === process.env.DATABASE_URL) {
  fallar(
    'BACKUP_DATABASE_URL es idéntica a DATABASE_URL -- no tiene sentido como override ' +
    'y suele ser una URL pegada por error. Si de verdad querés respaldar DATABASE_URL, ' +
    'quitá BACKUP_DATABASE_URL y corré el script sin ella.'
  );
}

let url;
try {
  url = new URL(origenUrlTexto);
} catch {
  fallar(`${usaOverride ? 'BACKUP_DATABASE_URL' : 'DATABASE_URL'} no es una URL de conexión válida.`);
}

const nombreBaseOrigen = (url.pathname || '/postgres').slice(1) || 'postgres';

// Confirmación visual del destino ANTES de tocar nada -- solo host/base
// (nunca usuario, password ni la URL completa), y de dónde salió (para que
// no haya ambigüedad sobre si se está usando el override o el valor normal).
console.log(
  `[backup] Origen: ${usaOverride ? 'BACKUP_DATABASE_URL' : 'DATABASE_URL'} -> ` +
  `host="${url.hostname}" base="${nombreBaseOrigen}"`
);

const verificacion = spawnSync('pg_dump', ['--version'], { stdio: 'ignore' });
if (verificacion.error) {
  fallar(
    'pg_dump no está instalado o no está en el PATH de este sistema.\n' +
    'Instalá las PostgreSQL Client Tools, o corré este script dentro de un ' +
    'contenedor con la imagen oficial de postgres.\n' +
    'Ver BACKUP.md para el detalle de las alternativas evaluadas.'
  );
}

const dirDestino = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
if (!existsSync(dirDestino)) mkdirSync(dirDestino, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archivoDestino = path.join(dirDestino, `gealmi-${nombreBaseOrigen}-${timestamp}.dump`);

const envLibpq = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: nombreBaseOrigen,
  PGSSLMODE: process.env.PGSSL === 'false' ? 'disable' : 'require'
};

// Nunca loguear PGPASSWORD ni la URL completa -- solo host/base, que no son secretos.
console.log(`[backup] Iniciando pg_dump de "${nombreBaseOrigen}" en "${url.hostname}" -> ${archivoDestino}`);

// -n public: todo lo real de GEALMI vive en el schema public (verificado
// contra information_schema.tables al validar el esquema de testing). Sin
// esto, un dump de la base completa incluiría cualquier schema al que el
// rol "postgres" tenga acceso -- en un proyecto Supabase eso puede incluir
// schemas internos de la plataforma (auth/storage/realtime/...), que un
// pg_restore --clean intentaría dropear y recrear sin ninguna necesidad.
const resultado = spawnSync('pg_dump', ['-Fc', '-n', 'public', '-f', archivoDestino], {
  env: envLibpq,
  stdio: ['ignore', 'inherit', 'inherit']
});

if (resultado.status !== 0) {
  fallar(`pg_dump terminó con código ${resultado.status}. Revisá el detalle de arriba (no se imprimen credenciales).`);
}

console.log(`[backup] Completado: ${archivoDestino}`);
