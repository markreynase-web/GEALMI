// js/rrhh/ficha.js
// Ficha completa del trabajador (fase R1): identidad, contrato, jornada, usuario
// vinculado y -- solo con rrhh.remuneraciones -- sueldo. Al abrir una ficha
// existente se muestra debajo su saldo de vacaciones y, con ese mismo permiso,
// el historial de sueldos y la estimación de gratificación y CTS (referencial).

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, invalidarEmpleados,
  fechaCorta, soles, tabla, hoyLima
} from './comun.js';

const REGIMENES = [
  { value: 'general', label: 'Régimen general' },
  { value: 'mype_pequena', label: 'Pequeña empresa (MYPE)' },
  { value: 'mype_micro', label: 'Microempresa (MYPE)' },
  { value: 'otro', label: 'Otro / a definir con el contador' }
];
const ESTADOS = [
  { value: 'activo', label: 'Activo' }, { value: 'inactivo', label: 'Inactivo' },
  { value: 'vacaciones', label: 'Vacaciones' }, { value: 'licencia', label: 'Licencia' }
];

function camposFicha(f, { usuarios, conSueldo }) {
  const v = (campo, defecto = '') => f?.[campo] ?? defecto;
  return [
    { titulo: 'Identidad' },
    { id: 'nombre', label: 'Nombre completo', valor: v('nombre'), requerido: true, ancho: 2, maxlength: 200 },
    { id: 'dni', label: 'DNI / carnet / pasaporte', valor: v('dni'), maxlength: 12, ayuda: '8 a 12 letras o números' },
    { id: 'fecha_nacimiento', label: 'Fecha de nacimiento', tipo: 'date', valor: v('fecha_nacimiento') },
    { id: 'direccion', label: 'Dirección', valor: v('direccion'), ancho: 2, maxlength: 250 },
    { id: 'telefono', label: 'Teléfono', valor: v('telefono'), maxlength: 60 },
    { id: 'email', label: 'Correo', tipo: 'email', valor: v('email'), maxlength: 200 },
    { id: 'contacto_emergencia_nombre', label: 'Contacto de emergencia', valor: v('contacto_emergencia_nombre'), ancho: 2, maxlength: 150 },
    { id: 'contacto_emergencia_telefono', label: 'Teléfono de emergencia', valor: v('contacto_emergencia_telefono'), maxlength: 60 },

    { titulo: 'Puesto y contrato' },
    { id: 'puesto', label: 'Puesto', valor: v('puesto'), maxlength: 150 },
    { id: 'departamento', label: 'Departamento', valor: v('departamento'), maxlength: 100 },
    { id: 'fecha_contratacion', label: 'Fecha de contratación', tipo: 'date', valor: v('fecha_contratacion', hoyLima()), requerido: true },
    { id: 'regimen_laboral', label: 'Régimen laboral', tipo: 'select', opciones: REGIMENES, valor: v('regimen_laboral', 'general'),
      ayuda: 'Define vacaciones, gratificación y CTS estimadas' },
    { id: 'tipo_contrato', label: 'Tipo de contrato', valor: v('tipo_contrato'), maxlength: 40, placeholder: 'Plazo fijo, indeterminado…' },
    { id: 'fecha_fin_contrato', label: 'Fin de contrato', tipo: 'date', valor: v('fecha_fin_contrato'), ayuda: 'Avisamos 30 días antes' },
    { id: 'fecha_cese', label: 'Fecha de cese', tipo: 'date', valor: v('fecha_cese'), ayuda: 'Al llegar esta fecha figura como cesado' },
    { id: 'estado', label: 'Estado escrito', tipo: 'select', opciones: ESTADOS, valor: v('estado', 'activo'),
      ayuda: 'El estado que se muestra sale de aquí, del cese y de las ausencias aprobadas' },

    { titulo: 'Jornada pactada (para el registro de asistencia)' },
    { id: 'jornada_horas_dia', label: 'Horas por día', tipo: 'number', valor: v('jornada_horas_dia', 8), min: 0.5, max: 12, step: '0.25' },
    { id: 'hora_entrada', label: 'Hora de entrada', tipo: 'time', valor: v('hora_entrada'), ayuda: 'Con ella se calcula la tardanza' },
    { id: 'hora_salida', label: 'Hora de salida', tipo: 'time', valor: v('hora_salida') },
    { id: 'refrigerio_minutos', label: 'Refrigerio (min)', tipo: 'number', valor: v('refrigerio_minutos', 60), min: 0, max: 240, step: '5' },
    { id: 'dias_laborables', tipo: 'dias', label: 'Días que trabaja', valor: v('dias_laborables', [1, 2, 3, 4, 5, 6]) },

    { titulo: 'Acceso a GEALMI' },
    { id: 'usuario_id', label: 'Usuario vinculado', tipo: 'select', valor: v('usuario_id'), ancho: 2,
      opciones: [{ value: '', label: 'Sin vincular' }, ...(usuarios || []).map(u => ({ value: u.id, label: `${u.nombre} · ${u.email}` }))],
      ayuda: 'Con un usuario vinculado el trabajador marca su asistencia en "Mi asistencia"' },

    ...(conSueldo ? [
      { titulo: 'Remuneración' },
      { id: 'salario', label: 'Sueldo mensual (S/)', tipo: 'number', valor: f ? v('salario', 0) : 0, min: 0, step: '0.01' },
      { id: 'motivo_salario', label: 'Motivo del cambio de sueldo', valor: '', ancho: 2, maxlength: 200, placeholder: 'Solo si lo cambias' }
    ] : []),

    { titulo: 'Notas' },
    { id: 'notas', label: 'Notas internas', tipo: 'textarea', valor: v('notas'), ancho: 4, filas: 2 }
  ];
}

// Del formulario al cuerpo que espera la API.
function cuerpoDesdeFormulario(valores) {
  const cuerpo = { ...valores };
  cuerpo.dias_laborables = [1, 2, 3, 4, 5, 6, 7].filter(d => valores[`dia_${d}`]);
  for (let d = 1; d <= 7; d++) delete cuerpo[`dia_${d}`];
  cuerpo.usuario_id = valores.usuario_id === '' ? null : Number(valores.usuario_id);
  if (!cuerpo.dias_laborables.length) throw new Error('Marca al menos un día de trabajo.');
  return cuerpo;
}

export async function abrirFicha(id = null) {
  const soloLectura = id ? !puede('rrhh.editar') : !puede('rrhh.crear');
  const conSueldo = puede('rrhh.remuneraciones');
  const empleados = id ? await listarEmpleados({ recargar: true }) : [];
  const ficha = id ? empleados.find(e => e.id === Number(id)) : null;
  if (id && !ficha) return;
  const usuarios = puede('rrhh.editar') || puede('rrhh.crear')
    ? await api(`/usuarios-disponibles${id ? `?incluir_de=${id}` : ''}`).catch(() => []) : [];

  modal({
    titulo: ficha ? ficha.nombre : 'Nuevo trabajador',
    montar: (cuerpo) => {
      cuerpo.innerHTML = `<div id="fichaForm"></div>${ficha ? '<div id="fichaResumen"></div>' : ''}`;
      const form = montarFormulario(cuerpo.querySelector('#fichaForm'), {
        campos: camposFicha(ficha, { usuarios, conSueldo }),
        textoGuardar: ficha ? 'Guardar cambios' : 'Registrar trabajador',
        alCancelar: cerrarPanelLateral,
        alGuardar: async (valores) => {
          const datos = cuerpoDesdeFormulario(valores);
          if (ficha) await api(`/${ficha.id}`, { metodo: 'PUT', cuerpo: datos });
          else await api('/', { metodo: 'POST', cuerpo: datos });
          invalidarEmpleados();
          cerrarPanelLateral();
          document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
        }
      });
      if (soloLectura) {
        form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
        form.querySelector('button[type="submit"]')?.remove();
      }
      if (ficha && puede('rrhh.eliminar')) {
        const zona = form.querySelector('.campo-accion');
        zona.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-ghost rrhh-btn-eliminar" style="margin-left:auto;">Eliminar trabajador</button>');
        zona.querySelector('.rrhh-btn-eliminar').addEventListener('click', async () => {
          if (!confirm(`¿Eliminar a ${ficha.nombre}? Solo se puede si no tiene historial.`)) return;
          try {
            await api(`/${ficha.id}`, { metodo: 'DELETE' });
            invalidarEmpleados();
            cerrarPanelLateral();
            document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
          } catch (err) {
            form.querySelector('[data-estado]').textContent = err.message;
            form.querySelector('[data-estado]').classList.add('error');
          }
        });
      }
      if (ficha) cargarResumen(cuerpo.querySelector('#fichaResumen'), ficha, conSueldo);
    }
  });
}

async function cargarResumen(cont, ficha, conSueldo) {
  cont.innerHTML = '<div class="rrhh-bloque"><h4>Vacaciones</h4><p class="form-status">Cargando…</p></div>';
  try {
    const saldo = await api(`/saldo-vacaciones/${ficha.id}`);
    cont.innerHTML = `<div class="rrhh-bloque"><h4>Vacaciones</h4>
      <div class="rrhh-datos">
        <div class="rrhh-dato"><b>${saldo.dias_ganados}</b><span>días ganados (${saldo.dias_por_anio} al año)</span></div>
        <div class="rrhh-dato"><b>${saldo.dias_tomados}</b><span>días tomados</span></div>
        <div class="rrhh-dato"><b>${saldo.saldo}</b><span>saldo estimado</span></div>
        <div class="rrhh-dato"><b>${saldo.dias_pendientes_aprobacion}</b><span>en solicitudes pendientes</span></div>
      </div>
      <p class="rrhh-legal" style="margin-top:10px;">${esc(saldo.referencial)}</p></div>`;
  } catch (err) {
    cont.innerHTML = `<div class="rrhh-bloque"><p class="form-status error">${esc(err.message)}</p></div>`;
  }
  if (conSueldo) await cargarSueldo(cont, ficha);
}

async function cargarSueldo(cont, ficha) {
  const bloque = document.createElement('div');
  bloque.className = 'rrhh-bloque';
  bloque.innerHTML = '<h4>Sueldo y beneficios</h4><p class="form-status">Cargando…</p>';
  cont.appendChild(bloque);
  try {
    const [historial, beneficios] = await Promise.all([api(`/remuneraciones/historial/${ficha.id}`), api(`/remuneraciones/beneficios/${ficha.id}`)]);
    bloque.innerHTML = `<h4>Sueldo y beneficios</h4>
      <div class="rrhh-datos">
        <div class="rrhh-dato"><b>${soles(beneficios.gratificacion.total)}</b><span>gratificación estimada · ${esc(beneficios.gratificacion.periodo)}</span></div>
        <div class="rrhh-dato"><b>${soles(beneficios.cts.monto)}</b><span>CTS estimada · ${esc(beneficios.cts.periodo)}</span></div>
      </div>
      ${beneficios.aplica ? '' : '<p class="campo-ayuda" style="margin-top:6px;">Con este régimen no se estiman gratificación ni CTS.</p>'}
      <p class="rrhh-legal" style="margin-top:10px;">${esc(beneficios.referencial)}</p>
      <h4 style="margin-top:14px;">Historial de sueldos</h4>
      ${tabla([
        { titulo: 'Vigente desde', celda: h => fechaCorta(h.vigente_desde) },
        { titulo: 'Antes', clase: 'num', celda: h => (h.sueldo_anterior === null ? '—' : soles(h.sueldo_anterior)) },
        { titulo: 'Nuevo', clase: 'num', celda: h => soles(h.sueldo_nuevo) },
        { titulo: 'Motivo', celda: h => esc(h.motivo || '') }
      ], historial, { vacio: 'Sin cambios de sueldo registrados.' })}`;
  } catch (err) {
    bloque.innerHTML = `<h4>Sueldo y beneficios</h4><p class="form-status error">${esc(err.message)}</p>`;
  }
}
