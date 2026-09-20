// tests/rrhh-desempeno-reclutamiento.test.js
// Paso 8 (RRHH), fases R6 y R7 contra un servidor real: evaluaciones con cinco
// criterios, capacitaciones con participantes, y el embudo de reclutamiento
// hasta "contratar" (que crea la ficha del trabajador en una transacción).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
let A, B;

before(async () => {
  servidor = await iniciarServidorTest();
  A = await montarEmpresa('A', ['admin', 'gerente', 'supervisor']);
  B = await montarEmpresa('B', ['admin']);
});
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function api(metodo, ruta, { token, body } = {}) {
  const r = await fetch(`${servidor.baseUrl}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || metodo === 'GET' ? undefined : JSON.stringify(body)
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}

const ROLES = { admin: 'administrador', gerente: 'gerente', supervisor: 'supervisor' };
async function montarEmpresa(sufijo, quienes) {
  const empresaId = await crearEmpresa(ctx, `desempeno-${sufijo}`, ['rrhh']);
  const e = { empresaId };
  for (const quien of quienes) {
    const cuenta = await crearUsuario(ctx, { empresaId, rolNombre: ROLES[quien] });
    e[quien] = { ...cuenta, token: await login(servidor.baseUrl, cuenta.email, cuenta.password) };
  }
  return e;
}
const conPermisos = (persona, empresaId, permisos) => jwt.sign({
  id: persona.usuarioId, nombre: 'Forjado', empresa_id: empresaId, empresa_nombre: 'QA', rol: 'forjado', permisos
}, process.env.JWT_SECRET, { expiresIn: 600 });

let contador = 0;
async function nuevoEmpleado(E, extra = {}) {
  const r = await api('POST', '/api/rrhh', { token: E.admin.token, body: { nombre: `Persona QA ${++contador}`, fecha_contratacion: '2024-01-01', salario: 1500, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo;
}
const NOTAS = { puntualidad: 4, calidad_trabajo: 5, trabajo_equipo: 3, iniciativa: 4, comunicacion: 3 };

// ---------------------------------------------------------------------------
// R6 -- evaluaciones
// ---------------------------------------------------------------------------

test('evaluación: cinco criterios de 1 a 5, promedio calculado por la base y evaluador tomado de la sesión', async () => {
  const f = await nuevoEmpleado(A);
  const r = await api('POST', '/api/rrhh/evaluaciones', {
    token: A.gerente.token,
    body: { empleado_id: f.id, periodo: '2026-S1', fecha: '2026-06-30', ...NOTAS, fortalezas: 'Responsable', oportunidades: 'Delegar más' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.promedio, 3.8, '(4+5+3+4+3)/5');

  const lista = (await api('GET', `/api/rrhh/evaluaciones?empleado_id=${f.id}`, { token: A.supervisor.token })).cuerpo;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].periodo, '2026-S1');
  assert.equal(lista[0].fecha, '2026-06-30');
  assert.equal(lista[0].empleado_nombre, f.nombre);
  assert.ok(lista[0].evaluador_nombre, 'queda quién evaluó');
  assert.equal(lista[0].fortalezas, 'Responsable');

  const { rows } = await pool.query('SELECT evaluador_id FROM evaluaciones WHERE id = $1', [r.cuerpo.id]);
  assert.equal(rows[0].evaluador_id, A.gerente.usuarioId, 'el evaluador es quien inició sesión, no lo que mande el body');
});

test('evaluación: criterios fuera de rango, incompletos o períodos vacíos se rechazan', async () => {
  const f = await nuevoEmpleado(A);
  const base = { empleado_id: f.id, periodo: '2026-S1', ...NOTAS };
  const casos = [
    [{ puntualidad: 0 }, /puntualidad/],
    [{ calidad_trabajo: 6 }, /calidad trabajo/],
    [{ trabajo_equipo: 3.5 }, /entero/],
    [{ iniciativa: 'alta' }, /iniciativa/],
    [{ comunicacion: '' }, /requerido/],
    [{ periodo: '' }, /período/i],
    [{ fecha: '2026-99-99' }, /fecha válida/i],
    [{ fortalezas: 'x'.repeat(2100) }, /2000/]
  ];
  for (const [extra, mensaje] of casos) {
    const r = await api('POST', '/api/rrhh/evaluaciones', { token: A.admin.token, body: { ...base, ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.cuerpo.error, mensaje);
  }
  const sinCriterio = { ...base }; delete sinCriterio.iniciativa;
  assert.equal((await api('POST', '/api/rrhh/evaluaciones', { token: A.admin.token, body: sinCriterio })).status, 400);
});

test('evaluación: editar recalcula el promedio; permisos por acción; otra empresa no la toca', async () => {
  const f = await nuevoEmpleado(A);
  const { cuerpo: { id } } = await api('POST', '/api/rrhh/evaluaciones', { token: A.admin.token, body: { empleado_id: f.id, periodo: 'Anual', ...NOTAS } });

  const edita = await api('PUT', `/api/rrhh/evaluaciones/${id}`, { token: A.gerente.token, body: { periodo: 'Anual', puntualidad: 5, calidad_trabajo: 5, trabajo_equipo: 5, iniciativa: 5, comunicacion: 5 } });
  assert.equal(edita.status, 200);
  assert.equal(edita.cuerpo.promedio, 5);

  assert.equal((await api('POST', '/api/rrhh/evaluaciones', { token: A.supervisor.token, body: { empleado_id: f.id, periodo: 'x', ...NOTAS } })).status, 403);
  assert.equal((await api('PUT', `/api/rrhh/evaluaciones/${id}`, { token: B.admin.token, body: { periodo: 'x', ...NOTAS } })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/evaluaciones/${id}`, { token: B.admin.token })).status, 404);
  assert.equal((await api('GET', `/api/rrhh/evaluaciones?empleado_id=${f.id}`, { token: B.admin.token })).cuerpo.length, 0);
  assert.equal((await api('DELETE', `/api/rrhh/evaluaciones/${id}`, { token: A.gerente.token })).status, 403);
  assert.equal((await api('DELETE', `/api/rrhh/evaluaciones/${id}`, { token: A.admin.token })).status, 204);
});

// ---------------------------------------------------------------------------
// R6 -- capacitaciones
// ---------------------------------------------------------------------------

test('capacitación: se crea con participantes, se consulta con su detalle y se puede filtrar por trabajador', async () => {
  const p1 = await nuevoEmpleado(A), p2 = await nuevoEmpleado(A), fuera = await nuevoEmpleado(A);
  const crea = await api('POST', '/api/rrhh/capacitaciones', {
    token: A.gerente.token,
    body: { nombre: 'Seguridad y salud en el trabajo', proveedor: 'SST Perú', fecha: '2026-05-10', horas: 4.5, costo: 350, obligatoria: true, participantes: [p1.id, p2.id] }
  });
  assert.equal(crea.status, 201, JSON.stringify(crea.cuerpo));
  const id = crea.cuerpo.id;

  const lista = (await api('GET', '/api/rrhh/capacitaciones', { token: A.supervisor.token })).cuerpo.find(c => c.id === id);
  assert.equal(lista.participantes, 2);
  assert.equal(lista.asistentes, 0);
  assert.equal(lista.horas, 4.5);
  assert.equal(lista.obligatoria, true);
  assert.equal(lista.fecha, '2026-05-10');

  const detalle = (await api('GET', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token })).cuerpo;
  assert.deepEqual(detalle.participantes.map(p => p.empleado_id).sort(), [p1.id, p2.id].sort());
  assert.ok(detalle.participantes.every(p => p.nombre && p.asistio === false));

  const deP1 = (await api('GET', `/api/rrhh/capacitaciones?empleado_id=${p1.id}`, { token: A.admin.token })).cuerpo;
  assert.ok(deP1.some(c => c.id === id));
  const deFuera = (await api('GET', `/api/rrhh/capacitaciones?empleado_id=${fuera.id}`, { token: A.admin.token })).cuerpo;
  assert.ok(!deFuera.some(c => c.id === id), 'quien no participó no la ve en su lista');
});

test('capacitación: editar reemplaza participantes solo si se envían, y registra asistencia y certificado', async () => {
  const p1 = await nuevoEmpleado(A), p2 = await nuevoEmpleado(A), p3 = await nuevoEmpleado(A);
  const { cuerpo: { id } } = await api('POST', '/api/rrhh/capacitaciones', { token: A.admin.token, body: { nombre: 'Atención al cliente', participantes: [p1.id, p2.id] } });

  const soloDatos = await api('PUT', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token, body: { nombre: 'Atención al cliente II', horas: 8 } });
  assert.equal(soloDatos.status, 200);
  assert.equal((await api('GET', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token })).cuerpo.participantes.length, 2, 'sin "participantes" en el body, la lista no se toca');

  const reemplaza = await api('PUT', `/api/rrhh/capacitaciones/${id}`, {
    token: A.admin.token,
    body: { nombre: 'Atención al cliente II', participantes: [{ empleado_id: p1.id, asistio: true, certificado_url: 'https://example.com/cert.pdf' }, { empleado_id: p3.id, asistio: false }] }
  });
  assert.equal(reemplaza.status, 200, JSON.stringify(reemplaza.cuerpo));
  const detalle = (await api('GET', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token })).cuerpo;
  assert.deepEqual(detalle.participantes.map(p => p.empleado_id).sort(), [p1.id, p3.id].sort(), 'p2 salió y p3 entró');
  const de1 = detalle.participantes.find(p => p.empleado_id === p1.id);
  assert.equal(de1.asistio, true);
  assert.equal(de1.certificado_url, 'https://example.com/cert.pdf');
  const lista = (await api('GET', '/api/rrhh/capacitaciones', { token: A.admin.token })).cuerpo.find(c => c.id === id);
  assert.equal(lista.asistentes, 1);

  const vacia = await api('PUT', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token, body: { nombre: 'Atención al cliente II', participantes: [] } });
  assert.equal(vacia.status, 200);
  assert.equal((await api('GET', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token })).cuerpo.participantes.length, 0, 'una lista vacía sí los quita a todos');
});

test('capacitación: participantes inválidos o de otra empresa no dejan nada a medias', async () => {
  const propio = await nuevoEmpleado(A);
  const deB = await nuevoEmpleado(B);
  const antes = (await pool.query('SELECT count(*)::int AS n FROM capacitaciones WHERE empresa_id = $1', [A.empresaId])).rows[0].n;

  const casos = [
    [[propio.id, deB.id], 404, /no es un trabajador de tu empresa/i],
    [[propio.id, propio.id], 400, /repetido/i],
    [['abc'], 400, /empleado_id/i],
    [[{ empleado_id: propio.id, certificado_url: 'http://inseguro.example.com/x' }], 400, /https/],
    ['no es una lista', 400, /lista/i]
  ];
  for (const [participantes, status, mensaje] of casos) {
    const r = await api('POST', '/api/rrhh/capacitaciones', { token: A.admin.token, body: { nombre: 'Curso', participantes } });
    assert.equal(r.status, status, JSON.stringify(participantes));
    assert.match(r.cuerpo.error, mensaje);
  }
  const despues = (await pool.query('SELECT count(*)::int AS n FROM capacitaciones WHERE empresa_id = $1', [A.empresaId])).rows[0].n;
  assert.equal(despues, antes, 'ninguna capacitación quedó creada');

  for (const extra of [{ horas: -1 }, { costo: -5 }, { nombre: '' }, { fecha: 'mañana' }]) {
    const r = await api('POST', '/api/rrhh/capacitaciones', { token: A.admin.token, body: { nombre: 'Curso', ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
});

test('capacitación: eliminarla borra a sus participantes; permisos y aislamiento', async () => {
  const p = await nuevoEmpleado(A);
  const { cuerpo: { id } } = await api('POST', '/api/rrhh/capacitaciones', { token: A.admin.token, body: { nombre: 'Curso a borrar', participantes: [p.id] } });
  assert.equal((await api('DELETE', `/api/rrhh/capacitaciones/${id}`, { token: A.gerente.token })).status, 403);
  assert.equal((await api('DELETE', `/api/rrhh/capacitaciones/${id}`, { token: B.admin.token })).status, 404);
  assert.equal((await api('GET', `/api/rrhh/capacitaciones/${id}`, { token: B.admin.token })).status, 404);
  assert.equal((await api('PUT', `/api/rrhh/capacitaciones/${id}`, { token: B.admin.token, body: { nombre: 'x' } })).status, 404);
  assert.equal((await api('POST', '/api/rrhh/capacitaciones', { token: A.supervisor.token, body: { nombre: 'x' } })).status, 403);
  assert.equal((await api('DELETE', `/api/rrhh/capacitaciones/${id}`, { token: A.admin.token })).status, 204);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM capacitacion_participantes WHERE capacitacion_id = $1', [id]);
  assert.equal(rows[0].n, 0);
  assert.ok(await pool.query('SELECT 1 FROM empleados WHERE id = $1', [p.id]).then(r => r.rows.length), 'el trabajador sigue existiendo');
});

test('un trabajador con capacitaciones no se puede eliminar (su historial se conserva)', async () => {
  const p = await nuevoEmpleado(A);
  await api('POST', '/api/rrhh/capacitaciones', { token: A.admin.token, body: { nombre: 'Curso', participantes: [p.id] } });
  const r = await api('DELETE', `/api/rrhh/${p.id}`, { token: A.admin.token });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /capacitaciones/);
});

// ---------------------------------------------------------------------------
// R7 -- vacantes y candidatos
// ---------------------------------------------------------------------------

async function nuevaVacante(E, extra = {}) {
  const r = await api('POST', '/api/rrhh/vacantes', { token: E.admin.token, body: { titulo: `Vendedor ${++contador}`, departamento: 'Ventas', cantidad: 1, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo.id;
}
async function nuevoCandidato(E, vacante_id, extra = {}) {
  const r = await api('POST', '/api/rrhh/candidatos', { token: E.admin.token, body: { vacante_id, nombre: `Candidata ${++contador}`, email: 'cand@example.com', telefono: '999111222', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo.id;
}

test('vacantes: se crean, se cierran con fecha, se reabren y se validan', async () => {
  const id = await nuevaVacante(A, { titulo: 'Cajero/a', cantidad: 2, descripcion: 'Turno tarde' });
  let v = (await api('GET', '/api/rrhh/vacantes', { token: A.supervisor.token })).cuerpo.find(x => x.id === id);
  assert.equal(v.estado, 'abierta');
  assert.equal(v.cantidad, 2);
  assert.equal(v.candidatos, 0);
  assert.equal(v.fecha_cierre, null);

  const cierra = await api('PUT', `/api/rrhh/vacantes/${id}`, { token: A.gerente.token, body: { titulo: 'Cajero/a', cantidad: 2, estado: 'cerrada' } });
  assert.equal(cierra.status, 200);
  v = (await api('GET', '/api/rrhh/vacantes', { token: A.admin.token })).cuerpo.find(x => x.id === id);
  assert.equal(v.estado, 'cerrada');
  assert.match(v.fecha_cierre, /^\d{4}-\d{2}-\d{2}$/, 'al cerrarla queda la fecha');

  await api('PUT', `/api/rrhh/vacantes/${id}`, { token: A.admin.token, body: { titulo: 'Cajero/a', cantidad: 2, estado: 'abierta' } });
  v = (await api('GET', '/api/rrhh/vacantes', { token: A.admin.token })).cuerpo.find(x => x.id === id);
  assert.equal(v.fecha_cierre, null, 'al reabrirla se borra');

  for (const extra of [{ titulo: '' }, { cantidad: 0 }, { cantidad: 1.5 }, { estado: 'archivada' }, { titulo: 'x'.repeat(200) }]) {
    const r = await api('POST', '/api/rrhh/vacantes', { token: A.admin.token, body: { titulo: 'Vendedor', ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal((await api('POST', '/api/rrhh/vacantes', { token: A.supervisor.token, body: { titulo: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/api/rrhh/vacantes/${id}`, { token: B.admin.token, body: { titulo: 'x' } })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/vacantes/${id}`, { token: B.admin.token })).status, 404);
  assert.ok(!(await api('GET', '/api/rrhh/vacantes', { token: B.admin.token })).cuerpo.some(x => x.id === id));
});

test('candidatos: validaciones, etapas, y a "contratado" solo se llega contratando', async () => {
  const vacante = await nuevaVacante(A);
  const id = await nuevoCandidato(A, vacante, { dni: 'ab123456', cv_url: 'https://example.com/cv.pdf', pretension_salarial: 1800, fuente: 'Computrabajo' });

  const malos = [
    [{ dni: '12' }, /documento/i],
    [{ cv_url: 'javascript:alert(1)' }, /https/],
    [{ cv_url: 'ftp://example.com/cv' }, /https/],
    [{ pretension_salarial: -1 }, /pretensión/i],
    [{ nombre: '' }, /nombre/i],
    [{ etapa: 'contratado' }, /etapa/],
    [{ etapa: 'archivado' }, /etapa/]
  ];
  for (const [extra, mensaje] of malos) {
    const r = await api('POST', '/api/rrhh/candidatos', { token: A.admin.token, body: { vacante_id: vacante, nombre: 'Cand', ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.cuerpo.error, mensaje);
  }
  assert.equal((await api('POST', '/api/rrhh/candidatos', { token: A.admin.token, body: { nombre: 'Sin vacante' } })).status, 400);
  assert.equal((await api('POST', '/api/rrhh/candidatos', { token: B.admin.token, body: { vacante_id: vacante, nombre: 'Cruzado' } })).status, 404, 'vacante de otra empresa');

  const lista = (await api('GET', `/api/rrhh/candidatos?vacante_id=${vacante}`, { token: A.admin.token })).cuerpo;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].dni, 'AB123456', 'el documento se guarda en mayúsculas');
  assert.equal(Number(lista[0].pretension_salarial), 1800);
  assert.equal(lista[0].etapa, 'postulado');
  const paraSupervisor = (await api('GET', `/api/rrhh/candidatos?vacante_id=${vacante}`, { token: A.supervisor.token })).cuerpo;
  assert.equal(paraSupervisor[0].pretension_salarial, null, 'la pretensión salarial es dato de remuneración');

  const mueve = await api('PUT', `/api/rrhh/candidatos/${id}`, { token: A.gerente.token, body: { nombre: 'Cand', etapa: 'entrevista' } });
  assert.equal(mueve.status, 200);
  assert.equal(mueve.cuerpo.etapa, 'entrevista');
  const finge = await api('PUT', `/api/rrhh/candidatos/${id}`, { token: A.admin.token, body: { nombre: 'Cand', etapa: 'contratado' } });
  assert.equal(finge.status, 400);
  assert.match(finge.cuerpo.error, /Contratar/);
  const sinEtapa = await api('PUT', `/api/rrhh/candidatos/${id}`, { token: A.admin.token, body: { nombre: 'Cand', notas: 'Buen perfil' } });
  assert.equal(sinEtapa.cuerpo.etapa, 'entrevista', 'si no se manda la etapa, se conserva');

  const filtrados = (await api('GET', `/api/rrhh/candidatos?etapa=entrevista`, { token: A.admin.token })).cuerpo;
  assert.ok(filtrados.some(c => c.id === id));
  assert.equal((await api('GET', '/api/rrhh/candidatos?etapa=inventada', { token: A.admin.token })).status, 400);
  assert.equal((await api('GET', `/api/rrhh/candidatos?vacante_id=${vacante}`, { token: B.admin.token })).cuerpo.length, 0);
  assert.equal((await api('PUT', `/api/rrhh/candidatos/${id}`, { token: B.admin.token, body: { nombre: 'x' } })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/candidatos/${id}`, { token: B.admin.token })).status, 404);

  const cuenta = (await api('GET', '/api/rrhh/vacantes', { token: A.admin.token })).cuerpo.find(v => v.id === vacante);
  assert.equal(cuenta.candidatos, 1);
  assert.equal(cuenta.en_proceso, 1);
});

test('contratar: crea la ficha del trabajador con los datos del candidato y cierra la vacante al cubrirse', async () => {
  const vacante = await nuevaVacante(A, { titulo: 'Almacenero', departamento: 'Logística', cantidad: 1 });
  const cand = await nuevoCandidato(A, vacante, { nombre: 'Luis Huamán', dni: '70707070', email: 'luis@example.com', telefono: '987654321' });

  const r = await api('POST', `/api/rrhh/candidatos/${cand}/contratar`, { token: A.admin.token, body: { fecha_contratacion: '2026-09-01', salario: 1400, regimen_laboral: 'mype_micro', tipo_contrato: 'plazo fijo' } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.vacante_cerrada, true, 'se buscaba 1 y ya está');

  const ficha = (await api('GET', '/api/rrhh', { token: A.admin.token })).cuerpo.find(e => e.id === r.cuerpo.empleado_id);
  assert.equal(ficha.nombre, 'Luis Huamán');
  assert.equal(ficha.puesto, 'Almacenero', 'el puesto sale de la vacante');
  assert.equal(ficha.departamento, 'Logística');
  assert.equal(ficha.dni, '70707070');
  assert.equal(ficha.email, 'luis@example.com');
  assert.equal(ficha.telefono, '987654321');
  assert.equal(ficha.fecha_contratacion, '2026-09-01');
  assert.equal(Number(ficha.salario), 1400);
  assert.equal(ficha.regimen_laboral, 'mype_micro');
  assert.equal(ficha.tipo_contrato, 'plazo fijo');

  const historial = (await api('GET', `/api/rrhh/remuneraciones/historial/${ficha.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(historial.length, 1);
  assert.equal(historial[0].motivo, 'Contratación');

  const c = (await api('GET', `/api/rrhh/candidatos?vacante_id=${vacante}`, { token: A.admin.token })).cuerpo[0];
  assert.equal(c.etapa, 'contratado');
  assert.equal(c.empleado_id, ficha.id);
  const v = (await api('GET', '/api/rrhh/vacantes', { token: A.admin.token })).cuerpo.find(x => x.id === vacante);
  assert.equal(v.estado, 'cerrada');
  assert.equal(v.contratados, 1);

  assert.equal((await api('POST', `/api/rrhh/candidatos/${cand}/contratar`, { token: A.admin.token, body: {} })).status, 409, 'no se contrata dos veces');
  assert.equal((await api('PUT', `/api/rrhh/candidatos/${cand}`, { token: A.admin.token, body: { nombre: 'x', etapa: 'descartado' } })).status, 409, 'ya contratado: se edita su ficha, no el candidato');
});

test('contratar: con varias plazas, la vacante sigue abierta hasta cubrirlas todas', async () => {
  const vacante = await nuevaVacante(A, { cantidad: 2 });
  const c1 = await nuevoCandidato(A, vacante), c2 = await nuevoCandidato(A, vacante);
  const primera = await api('POST', `/api/rrhh/candidatos/${c1}/contratar`, { token: A.admin.token, body: {} });
  assert.equal(primera.status, 201);
  assert.equal(primera.cuerpo.vacante_cerrada, false);
  assert.equal((await api('GET', '/api/rrhh/vacantes', { token: A.admin.token })).cuerpo.find(x => x.id === vacante).estado, 'abierta');
  const segunda = await api('POST', `/api/rrhh/candidatos/${c2}/contratar`, { token: A.admin.token, body: {} });
  assert.equal(segunda.cuerpo.vacante_cerrada, true);
});

test('contratar: un fallo no deja a medias (sin ficha huérfana ni candidato marcado)', async () => {
  const vacante = await nuevaVacante(A);
  await nuevoEmpleado(A, { dni: '60606060' });
  const conDniRepetido = await nuevoCandidato(A, vacante, { dni: '60606060' });
  const antes = (await pool.query('SELECT count(*)::int AS n FROM empleados WHERE empresa_id = $1', [A.empresaId])).rows[0].n;

  const r = await api('POST', `/api/rrhh/candidatos/${conDniRepetido}/contratar`, { token: A.admin.token, body: { salario: 1000 } });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /documento/i);
  const despues = (await pool.query('SELECT count(*)::int AS n FROM empleados WHERE empresa_id = $1', [A.empresaId])).rows[0].n;
  assert.equal(despues, antes, 'no se creó ninguna ficha');
  const c = (await api('GET', `/api/rrhh/candidatos?vacante_id=${vacante}`, { token: A.admin.token })).cuerpo[0];
  assert.equal(c.etapa, 'postulado', 'el candidato sigue como estaba');
  assert.equal(c.empleado_id, null);
});

test('contratar: descartados no, sin permiso no, con fecha o salario inválidos no, y entre empresas tampoco', async () => {
  const vacante = await nuevaVacante(A);
  const descartado = await nuevoCandidato(A, vacante, { etapa: 'descartado' });
  const r = await api('POST', `/api/rrhh/candidatos/${descartado}/contratar`, { token: A.admin.token, body: {} });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /descartado/i);

  const normal = await nuevoCandidato(A, vacante);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: A.supervisor.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: B.admin.token, body: {} })).status, 404);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: A.admin.token, body: { fecha_contratacion: 'ayer' } })).status, 400);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: A.admin.token, body: { salario: -10 } })).status, 400);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: A.admin.token, body: { regimen_laboral: 'raro' } })).status, 400);
  assert.equal((await api('POST', '/api/rrhh/candidatos/abc/contratar', { token: A.admin.token, body: {} })).status, 404);

  const sinSueldos = conPermisos(A.gerente, A.empresaId, ['rrhh.ver', 'rrhh.crear', 'rrhh.editar']);
  assert.equal((await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: sinSueldos, body: { salario: 5000 } })).status, 403, 'fijar sueldo pide rrhh.remuneraciones');
  const sinFijarSueldo = await api('POST', `/api/rrhh/candidatos/${normal}/contratar`, { token: sinSueldos, body: {} });
  assert.equal(sinFijarSueldo.status, 201, 'pero contratar sin fijar sueldo sí se puede');
  const ficha = (await api('GET', '/api/rrhh', { token: A.admin.token })).cuerpo.find(e => e.id === sinFijarSueldo.cuerpo.empleado_id);
  assert.equal(Number(ficha.salario), 0);
});

test('eliminar una vacante borra a sus candidatos, pero no a quien ya fue contratado', async () => {
  const vacante = await nuevaVacante(A);
  const c1 = await nuevoCandidato(A, vacante), c2 = await nuevoCandidato(A, vacante);
  const contrata = await api('POST', `/api/rrhh/candidatos/${c1}/contratar`, { token: A.admin.token, body: {} });
  assert.equal(contrata.status, 201);

  assert.equal((await api('DELETE', `/api/rrhh/vacantes/${vacante}`, { token: A.gerente.token })).status, 403);
  assert.equal((await api('DELETE', `/api/rrhh/vacantes/${vacante}`, { token: A.admin.token })).status, 204);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidatos WHERE id = ANY($1::int[])', [[c1, c2]]);
  assert.equal(rows[0].n, 0);
  const fichas = (await api('GET', '/api/rrhh', { token: A.admin.token })).cuerpo;
  assert.ok(fichas.some(e => e.id === contrata.cuerpo.empleado_id), 'el trabajador contratado sigue existiendo');
});
