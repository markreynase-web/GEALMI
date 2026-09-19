// js/app.js
// Orquestador: mantiene el estado de la app, conecta los botones del DOM,
// y decide qué le pasa a renderTodo(). Es el único módulo con estado mutable
// del dataset cargado (antes vivía en window.__DATA / window.__ULTIMO_RESULTADO).

import { procesarTextoCSV, leerTextoArchivo, leerTextoEntradaZip } from './parsing.js';
import { guardarDatosLocal, cargarDatosLocal, borrarDatosLocal } from './storage.js';
import { renderTodo, redimensionarTodosLosGraficos } from './dashboard.js';
import { cargarConfigEmpresa, buscarModulo } from './config.js';
import { renderSidebar } from '../components/sidebar.js';
import { renderGealmiAiWidget } from '../components/gealmiAiWidget.js';
import { renderTopbar } from '../components/topbar.js';
import { renderFooter } from '../components/footer.js';
import { iniciarModoBackend } from './modoBackend.js';
import { renderFormulario } from '../components/formularioRegistro.js';
import { renderTabla } from '../components/tablaRegistros.js';
import { abrirPanelLateral, cerrarPanelLateral } from '../components/panelLateral.js';
import { tienePermiso, haySesionActiva, obtenerSesion } from './sesion.js';
import { ESQUEMAS } from './esquemas.js';
import { crearRegistro } from './api.js';
import { exportarFilasCSV, LIMITE_FILAS_EXPORT } from './exportarCSV.js';
import { renderVentasDashboard } from './ventasDashboard.js';
import { renderClientesDashboard } from './clientesDashboard.js';
import { renderFinanzasDashboard } from './finanzasDashboard.js';
import { renderInventarioDashboard } from './inventarioDashboard.js';
import { renderPostventaDashboard } from './postventaDashboard.js';
import { renderVehiculosDashboard } from './vehiculosDashboard.js';
import { renderRepuestosDashboard } from './repuestosDashboard.js';
import { renderAgendaDashboard } from './agendaDashboard.js';
import { renderTratamientosDashboard } from './tratamientosDashboard.js';
import { renderPlanesTratamientoDashboard } from './planesTratamientoDashboard.js';
import { renderSegurosDentalesDashboard } from './segurosDentalesDashboard.js';
import { renderRecetasOpticasDashboard } from './recetasOpticasDashboard.js';
import { renderOrdenesLaboratorioDashboard } from './ordenesLaboratorioDashboard.js';
import { renderSegurosVisionDashboard } from './segurosVisionDashboard.js';
import { renderComprasDashboard } from './comprasDashboard.js';
import { renderRrhhDashboard } from './rrhhDashboard.js';
import { renderProduccionDashboard } from './produccionDashboard.js';

// Rediseño v3: algunos módulos reemplazan por completo el motor genérico de
// dashboard.js con su propia "Vista Ejecutiva" (KPIs/gráficos pensados para
// lo que ese módulo necesita, no columnas auto-detectadas de un CSV). Un
// módulo sin entrada acá sigue usando renderTodo() tal cual, sin cambios.
// La firma es (filasCrudas, backendActivo) -- el segundo parámetro es solo
// para los que necesitan datos de OTRO módulo (ej. Clientes trae su propio
// historial de ventas/postventa); los que no lo usan simplemente lo ignoran.
const RENDERERS_BESPOKE = {
  ventas: renderVentasDashboard, clientes: renderClientesDashboard,
  finanzas: renderFinanzasDashboard, inventario: renderInventarioDashboard,
  postventa: renderPostventaDashboard, vehiculos: renderVehiculosDashboard,
  repuestos: renderRepuestosDashboard, agenda: renderAgendaDashboard,
  tratamientos: renderTratamientosDashboard, planes_tratamiento: renderPlanesTratamientoDashboard,
  seguros_dentales: renderSegurosDentalesDashboard, recetas_opticas: renderRecetasOpticasDashboard,
  ordenes_laboratorio: renderOrdenesLaboratorioDashboard, seguros_vision: renderSegurosVisionDashboard,
  compras: renderComprasDashboard, rrhh: renderRrhhDashboard, produccion: renderProduccionDashboard
};

// Namespace de esta página dentro de localStorage. Cada página de módulo (ventas.html,
// inventario.html, clientes.html, ...) declara el suyo en <body data-modulo="...">,
// así cada módulo guarda sus datos por separado y no se pisan entre sí.
const NAMESPACE = document.body.dataset.modulo || 'ventas';

// --- Estado de la aplicación (reemplaza a los antiguos window.__DATA / __ULTIMO_RESULTADO) ---
const estado = {
  datos: null,        // filas ya procesadas del archivo cargado por el usuario
  ultimoResultado: null, // { archivo, mapa, stats, cols }
};

// Si el módulo actual tiene baseDeDatos:true en config y el backend responde,
// esto deja de ser null y refrescar() empieza a leer de la API en vez de
// localStorage/CSV local. Ver activarCapturaSiCorresponde().
let backendActivo = null;

// Término de la búsqueda global del topbar (ver components/topbar.js), leído
// UNA vez de sessionStorage al arrancar la página (ver iniciar()) y guardado
// acá -- no en refrescarTablaBackend() -- porque activarCapturaSiCorresponde()
// llama a refrescarTablaBackend() dos veces seguidas al iniciar (una vía
// refrescar(), otra al final); si cada llamada leyera y borrara
// sessionStorage por su cuenta, la primera se quedaría con el filtro y la
// segunda (la que de verdad queda pintada) ya lo encontraría vacío. Se limpia
// después de que el arranque termina, para que refrescos posteriores
// (ej. tras crear un registro) no lo vuelvan a aplicar.
let terminoBusquedaPendiente = '';

function generarDatosEjemplo() {
  const productos = [
    { nombre: "Coca Cola 500ml", categoria: "Bebidas", precio: 3.5 },
    { nombre: "Pan Francés (kg)", categoria: "Panadería", precio: 6.0 },
    { nombre: "Leche Gloria 1L", categoria: "Lácteos", precio: 5.2 },
    { nombre: "Arroz Costeño 5kg", categoria: "Abarrotes", precio: 19.9 },
    { nombre: "Detergente Ariel 1kg", categoria: "Limpieza", precio: 14.5 },
  ];
  const hoy = new Date();
  const filas = [];
  for (let i = 0; i < 60; i++) {
    const dia = new Date(hoy); dia.setDate(hoy.getDate() - i);
    const n = 2 + Math.floor(Math.random() * 4);
    for (let v = 0; v < n; v++) {
      const p = productos[Math.floor(Math.random() * productos.length)];
      const cant = 1 + Math.floor(Math.random() * 3);
      filas.push({ fecha: dia.toISOString().slice(0, 10), producto: p.nombre, categoria: p.categoria, monto: +(p.precio * cant).toFixed(2) });
    }
  }
  return filas;
}

const DATA_EJEMPLO = generarDatosEjemplo();

function obtenerFuenteActual() {
  if (estado.datos) {
    return { filas: estado.datos, mapa: estado.ultimoResultado.mapa, stats: estado.ultimoResultado.stats, cols: estado.ultimoResultado.cols };
  }
  const ejemplo = DATA_EJEMPLO.map(r => ({ _fecha: r.fecha, _numero: r.monto, _cat1: r.producto, _cat2: r.categoria }));
  return { filas: ejemplo, mapa: { colFecha: 'fecha', colNum: 'monto', colCat1: 'producto', colCat2: 'categoria' }, stats: null, cols: ['fecha', 'producto', 'categoria', 'monto'] };
}

function refrescar() {
  if (backendActivo) { refrescarDesdeBackend(); refrescarTablaBackend(); return; }
  renderTodo(obtenerFuenteActual());
}

async function refrescarDesdeBackend() {
  if (!backendActivo) return;

  const renderBespoke = RENDERERS_BESPOKE[NAMESPACE];
  if (renderBespoke) {
    // Filas crudas, no las transformadas de modoBackend.js -- esas solo
    // guardan _fecha/_numero/_cat1/_cat2 (lo que necesita el motor
    // genérico) y pierden cliente_id/producto_id y el resto de columnas
    // reales que un dashboard bespoke sí necesita. Sin filtro de fecha acá:
    // cada dashboard bespoke trae su propio selector de período y filtra
    // client-side (mismo patrón ya usado en Inicio).
    const filas = await backendActivo.listarCrudo({});
    renderBespoke(filas, backendActivo);
    return;
  }

  const fuente = await backendActivo.obtenerFuente({
    desde: document.getElementById('fechaDesde').value || undefined,
    hasta: document.getElementById('fechaHasta').value || undefined
  });
  if (fuente) renderTodo(fuente);
}

function mostrarEstado(msg, tipo) {
  const el = document.getElementById('uploadStatus');
  el.textContent = msg;
  el.style.color = tipo === 'error' ? 'var(--coral)' : (tipo === 'ok' ? 'var(--teal-strong)' : 'var(--muted)');
}

async function manejarArchivo(file) {
  const nombre = file.name.toLowerCase();
  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;
  const resultados = [];
  const errores = [];

  try {
    if (nombre.endsWith('.zip')) {
      let zip;
      try { zip = await JSZip.loadAsync(file); }
      catch (err) { mostrarEstado('No se pudo abrir el ZIP: ' + err.message, 'error'); return; }

      const entradas = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.csv'));
      if (entradas.length === 0) { mostrarEstado('El ZIP no contiene archivos .csv.', 'error'); return; }

      for (let i = 0; i < entradas.length; i++) {
        const entrada = entradas[i];
        try {
          const texto = await leerTextoEntradaZip(entrada);
          resultados.push(await procesarTextoCSV(texto, entrada.name, (hecho, total) => mostrarEstado(`Procesando ${entrada.name} (${i + 1}/${entradas.length}): ${hecho}/${total} filas…`, 'info')));
        } catch (err) {
          errores.push(`${entrada.name}: ${err.message}`);
        }
      }
    } else if (nombre.endsWith('.csv')) {
      try {
        const texto = await leerTextoArchivo(file);
        resultados.push(await procesarTextoCSV(texto, file.name, (hecho, total) => mostrarEstado(`Procesando: ${hecho}/${total} filas…`, 'info')));
      } catch (err) {
        errores.push(`${file.name}: ${err.message}`);
      }
    } else {
      mostrarEstado('Formato no soportado. Sube un .csv o un .zip con .csv adentro.', 'error');
      return;
    }

    const todasFilas = resultados.flatMap(r => r.filas);
    if (todasFilas.length === 0) {
      mostrarEstado('No se encontraron filas válidas. ' + (errores.length ? 'Errores: ' + errores.join(' | ') : ''), 'error');
      return;
    }

    estado.ultimoResultado = resultados.find(r => r.filas.length > 0) || resultados[0];
    estado.datos = todasFilas;
    document.getElementById('fechaDesde').value = '';
    document.getElementById('fechaHasta').value = '';
    refrescar();

    const guardadoOk = guardarDatosLocal(NAMESPACE, { datos: estado.datos, ultimoResultado: estado.ultimoResultado, bizName: document.getElementById('bizName').value });
    document.getElementById('clearStorageBtn').style.display = guardadoOk ? 'inline-flex' : document.getElementById('clearStorageBtn').style.display;
    const resumen = `Listo: ${todasFilas.length} filas de ${resultados.length} archivo(s).`
      + (errores.length ? ` ${errores.length} archivo(s) con error: ${errores.join(' | ')}` : '')
      + (guardadoOk ? ' Guardado en este navegador para la próxima vez.' : ' (No se pudo guardar localmente: el archivo es muy grande para el almacenamiento del navegador; deberás volver a subirlo si recargas la página.)');
    mostrarEstado(resumen, errores.length ? 'error' : 'ok');
  } catch (err) {
    mostrarEstado('Error inesperado: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function textoRangoActual() {
  const wrap = document.getElementById('dateRangeWrap');
  if (!wrap || wrap.style.display === 'none') return 'Todo el periodo disponible';
  const d = document.getElementById('fechaDesde').value;
  const h = document.getElementById('fechaHasta').value;
  if (!d || !h) return 'Todo el periodo disponible';
  return `Periodo: ${d} al ${h}`;
}

function restaurarDatosLocalSiExisten() {
  const datos = cargarDatosLocal(NAMESPACE);
  if (!datos || !datos.filas || !datos.filas.length) return;
  estado.datos = datos.filas;
  estado.ultimoResultado = { archivo: datos.archivo, mapa: datos.mapa, stats: datos.stats, cols: datos.cols };
  if (datos.bizName) document.getElementById('bizName').value = datos.bizName;
  document.getElementById('clearStorageBtn').style.display = 'inline-flex';
  const fecha = datos.guardadoEl ? new Date(datos.guardadoEl).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  mostrarEstado(`Datos restaurados de tu última carga (${datos.filas.length} filas)${fecha ? ' · guardados el ' + fecha : ''}. Solo están en este navegador.`, 'ok');
}

function wireEventos() {
  document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    manejarArchivo(file).finally(() => { e.target.value = ''; });
  });

  document.getElementById('exportPdfBtn').addEventListener('click', () => {
    const nombreNegocio = document.getElementById('bizName').value.trim() || 'Panel de datos';
    const generadoEl = new Date().toLocaleString('es-PE', { dateStyle: 'long', timeStyle: 'short' });
    document.getElementById('printBizName').textContent = nombreNegocio;
    document.getElementById('printMeta').textContent = `Resumen ejecutivo · ${textoRangoActual()} · generado el ${generadoEl}`;

    const tituloOriginal = document.title;
    const fechaArchivo = new Date().toISOString().slice(0, 10);
    document.title = `${nombreNegocio} - resumen ejecutivo - ${fechaArchivo}`;
    window.print();
    document.title = tituloOriginal;
  });

  // Chart.js no siempre detecta el cambio de layout que provoca window.print();
  // forzamos el recálculo justo antes (para el PDF) y justo después (para volver a la pantalla).
  window.addEventListener('beforeprint', redimensionarTodosLosGraficos);
  window.addEventListener('afterprint', redimensionarTodosLosGraficos);

  document.getElementById('fechaDesde').addEventListener('change', refrescar);
  document.getElementById('fechaHasta').addEventListener('change', refrescar);
  document.getElementById('resetRangoBtn').addEventListener('click', () => {
    document.getElementById('fechaDesde').value = '';
    document.getElementById('fechaHasta').value = '';
    refrescar();
  });
  document.getElementById('bizName').addEventListener('change', () => {
    if (estado.datos) guardarDatosLocal(NAMESPACE, { datos: estado.datos, ultimoResultado: estado.ultimoResultado, bizName: document.getElementById('bizName').value });
  });

  document.getElementById('clearStorageBtn').addEventListener('click', () => {
    if (!confirm('¿Borrar los datos guardados en este navegador? Tendrás que volver a subir tu archivo.')) return;
    borrarDatosLocal(NAMESPACE);
    estado.datos = null;
    estado.ultimoResultado = null;
    document.getElementById('bizName').value = 'Mi proyecto de datos';
    document.getElementById('fechaDesde').value = '';
    document.getElementById('fechaHasta').value = '';
    document.getElementById('clearStorageBtn').style.display = 'none';
    mostrarEstado('Se borraron los datos guardados en este navegador.', 'info');
    refrescar();
  });
}

// Aplica el nombre de la empresa, el logo y el título del módulo actual usando
// config/company.json. Si el usuario ya tiene un bizName guardado en localStorage,
// restaurarDatosLocalSiExisten() lo sobreescribe después (ese dato local siempre
// tiene prioridad sobre el valor por defecto de config).
function aplicarBranding(config) {
  const modulo = buscarModulo(config, NAMESPACE);
  const nombreModulo = modulo ? modulo.label : NAMESPACE;

  // Estos selectores por clase (.mark, .biz-name) siguen funcionando igual
  // esté la marca dentro del header viejo o del sidebar.brand nuevo -- ambos
  // marcados les ponen esas mismas clases, así que este código no cambió.
  const markEl = document.querySelector('.mark');
  if (markEl) markEl.textContent = config.logo || 'PD';

  const bizInput = document.getElementById('bizName');
  if (bizInput) bizInput.value = config.bizName || bizInput.value;

  // '.subtitle' es del header viejo (páginas que todavía no migraron al
  // sidebar); '#sidebarSubtitle'/'#topbarTitle'/'#topbarSubtitle' son del
  // layout nuevo. Se actualizan los que existan en la página actual.
  const subtitleTexto = `PANEL DE ${nombreModulo.toUpperCase()}`;
  const subtitleEl = document.querySelector('.subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitleTexto;

  const sidebarSubtitleEl = document.getElementById('sidebarSubtitle');
  if (sidebarSubtitleEl) sidebarSubtitleEl.textContent = `PANEL DE ${nombreModulo.toUpperCase()}`;

  const topbarTitleEl = document.getElementById('topbarTitle');
  if (topbarTitleEl) topbarTitleEl.textContent = nombreModulo;

  const topbarSubtitleEl = document.getElementById('topbarSubtitle');
  if (topbarSubtitleEl) topbarSubtitleEl.textContent = subtitleTexto;

  document.title = `${config.bizName || 'GEALMI'} — ${nombreModulo}`;
}

// Si el módulo actual tiene baseDeDatos:true en config/company.json, intenta
// conectar con el backend: si responde, arma el formulario y la tabla de ese
// módulo a partir de su esquema (js/esquemas.js), oculta la carga de archivo
// local (para no mezclar los dos modos) y pasa el dashboard a leer de la API.
// Si no responde, no hace nada más que avisar — la página sigue funcionando
// en modo local como siempre.
async function activarCapturaSiCorresponde(config) {
  const modulo = buscarModulo(config, NAMESPACE);
  if (!modulo || !modulo.baseDeDatos || !config.apiBaseUrl) return;

  const seccion = document.getElementById('capturaSection');
  const backend = await iniciarModoBackend({
    baseUrl: config.apiBaseUrl,
    moduloId: NAMESPACE,
    onError: (msg) => mostrarEstado(msg, 'error')
  });
  if (!backend || !seccion) return;

  backendActivo = backend;
  document.getElementById('uploadBtn').style.display = 'none';
  document.getElementById('clearStorageBtn').style.display = 'none';
  mostrarEstado('', 'info');
  // La Vista Ejecutiva se pintó antes con datos locales (en iniciar(), antes
  // de que backendActivo existiera); ahora que sí hay backend, se vuelve a
  // pintar con los datos reales -- si no, se queda mostrando lo viejo aunque
  // la tabla de abajo ya esté leyendo de la base de datos. Se llama solo a
  // refrescarDesdeBackend() (no a refrescar(), que también dispara
  // refrescarTablaBackend()) porque la tabla ya se refresca una vez, al
  // final de esta función -- si acá se hiciera doble, la tabla pediría los
  // registros dos veces seguidas en cada carga de página.
  refrescarDesdeBackend();

  // Vista Ejecutiva (KPIs/gráficos, en <main>) vs Vista Operativa (la tabla
  // de registros): antes se mostraban las dos apiladas siempre; ahora son
  // pestañas y arranca en Vista Ejecutiva.
  const tabs = document.getElementById('vistaTabs');
  const zonaEjecutiva = document.querySelector('main');
  seccion.style.display = 'none';
  if (tabs) {
    tabs.style.display = 'flex';
    tabs.querySelectorAll('.vista-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('.vista-tab').forEach(b => b.classList.remove('activo'));
        btn.classList.add('activo');
        const esOperativa = btn.dataset.vista === 'operativa';
        seccion.style.display = esOperativa ? 'block' : 'none';
        if (zonaEjecutiva) zonaEjecutiva.style.display = esOperativa ? 'none' : 'block';
      });
    });
  }

  const puedeCrear = tienePermiso(`${NAMESPACE}.crear`);

  // Campos con "fuente" en su esquema (ver js/esquemas.js) piden sus
  // opciones frescas al backend cada vez que se abre el formulario, en vez
  // de vivir hardcodeadas -- así ventas.producto_id, vehiculos.cliente_id,
  // postventa.cliente_id/vehiculo_id/repuesto_id, etc. funcionan todos con
  // el mismo mecanismo (antes esto solo corría para NAMESPACE==='ventas',
  // con 2 campos escritos a mano). 'categoriasInventario' es la única
  // excepción: no es un módulo real con su propio endpoint, son valores
  // derivados de inventario.categoria, así que se resuelve aparte.
  const CONSTRUCTORES_OPCION = {
    clientes: cl => ({ value: cl.id, label: cl.nombre }),
    // Sub-fase F: sucursal_id en Inventario (ver js/esquemas.js). "Sucursal
    // Principal" queda igual de visible que cualquier otra -- no hace falta
    // marcarla especial acá, ya se distingue sola por el nombre.
    sucursales: s => ({ value: s.id, label: s.nombre }),
    inventario: p => ({
      value: p.id, label: `${p.nombre} - ${p.stock} disponible(s)`,
      extra: { stock: Number(p.stock), categoria: p.categoria || '', precioSugerido: Number(p.precio_unitario) || 0 }
    }),
    vehiculos: v => ({ value: v.id, label: `${v.marca} ${v.modelo}${v.anio ? ' ' + v.anio : ''} · ${v.placa}` }),
    repuestos: r => ({
      value: r.id, label: `${r.nombre} - ${r.stock} disponible(s)`,
      extra: { stock: Number(r.stock), precioSugerido: Number(r.precio_unitario) || 0 }
    }),
    tratamientos: t => ({ value: t.id, label: `${t.procedimiento}${t.pieza_dental ? ' (pieza ' + t.pieza_dental + ')' : ''} · ${t.cliente_nombre}` }),
    recetas_opticas: r => ({ value: r.id, label: `${String(r.fecha).slice(0, 10)} · ${r.cliente_nombre}` }),
    ordenes_laboratorio: o => ({ value: o.id, label: `${o.armazon || 'Orden'}${o.tipo_lente ? ' (' + o.tipo_lente + ')' : ''} · ${o.cliente_nombre}` }),
    mascotas: m => ({ value: m.id, label: `${m.nombre} (${m.especie}) · ${m.cliente_nombre}` }),
    atenciones_veterinarias: a => ({ value: a.id, label: `${a.procedimiento} · ${a.mascota_nombre}` }),
    flota: f => ({ value: f.id, label: `${f.placa} · ${f.marca} ${f.modelo}` }),
    conductores: c => ({ value: c.id, label: c.nombre }),
    rutas: r => ({ value: r.id, label: r.nombre }),
    mesas: m => ({ value: m.id, label: `Mesa ${m.numero}${m.zona ? ' · ' + m.zona : ''}` }),
    combos: c => ({ value: c.id, label: `${c.nombre} - S/ ${Number(c.precio).toFixed(2)}` }),
    planes_membresia: p => ({ value: p.id, label: `${p.nombre} · ${p.duracion_meses} mes(es) · S/ ${Number(p.precio).toFixed(2)}` })
  };

  async function esquemaConOpcionesFrescas() {
    // Campos con buscar:true (ver js/esquemas.js) NO precargan su lista --
    // esa es justo la idea (fuente puede tener miles de filas). En vez de
    // opcionesResueltas, se les cuelga buscarFuente()/mapearOpcion() para
    // que el combobox (componentes/comboboxBusqueda.js, montado desde
    // formularioRegistro.js) pida resultados en vivo, reusando el mismo
    // CONSTRUCTORES_OPCION de siempre -- ni el combobox ni formularioRegistro.js
    // necesitan saber qué forma tiene una fila de "inventario".
    const fuentes = [...new Set(
      backend.esquema.campos.filter(c => !c.buscar).map(c => c.fuente).filter(f => f && CONSTRUCTORES_OPCION[f])
    )];
    const listas = Object.fromEntries(await Promise.all(
      fuentes.map(async f => [f, await backend.listarDeModulo(f)])
    ));

    let categoriasUnicas = null;
    if (backend.esquema.campos.some(c => c.fuente === 'categoriasInventario')) {
      const productos = listas.inventario || await backend.listarDeModulo('inventario');
      categoriasUnicas = [...new Set((productos || []).map(p => p.categoria).filter(Boolean))];
    }

    const campos = backend.esquema.campos.map(c => {
      if (c.fuente === 'categoriasInventario') {
        return { ...c, opcionesResueltas: (categoriasUnicas || []).map(cat => ({ value: cat, label: cat })) };
      }
      if (c.buscar && c.fuente && CONSTRUCTORES_OPCION[c.fuente]) {
        return {
          ...c,
          buscarFuente: (termino) => backend.buscarEnModulo(c.fuente, termino, 20),
          mapearOpcion: CONSTRUCTORES_OPCION[c.fuente]
        };
      }
      if (!c.fuente || !listas[c.fuente]) return c;
      return { ...c, opcionesResueltas: listas[c.fuente].map(CONSTRUCTORES_OPCION[c.fuente]) };
    });
    return { ...backend.esquema, campos };
  }

  function abrirFormularioClienteRapido(body, volverAVentas) {
    body.innerHTML = '<div id="formularioClienteRapido"></div>';
    renderFormulario('formularioClienteRapido', ESQUEMAS.clientes, async (valores) => {
      const res = await crearRegistro(config.apiBaseUrl, 'clientes', valores);
      if (res) volverAVentas();
      return res;
    }, { puedeCrear: tienePermiso('clientes.crear') });
  }

  // El formulario ya no vive fijo en la página: se dibuja adentro del panel
  // lateral recién cuando el usuario abre "+ Nuevo", y se vuelve a dibujar
  // desde cero cada vez que se abre (así siempre parte limpio).
  const btnNuevo = document.getElementById('btnNuevoRegistro');
  if (btnNuevo) {
    btnNuevo.style.display = puedeCrear ? 'inline-flex' : 'none';
    btnNuevo.addEventListener('click', async () => {
      const esquema = await esquemaConOpcionesFrescas();
      const moduloActual = buscarModulo(config, NAMESPACE);
      abrirPanelLateral({
        titulo: `Nuevo${esquema.etiqueta ? ' ' + esquema.etiqueta : ' registro'}`,
        icono: moduloActual?.icon || '📝',
        montar: (body) => {
          function dibujarFormularioVenta() {
            body.innerHTML = '<div id="formularioCaptura"></div>';
            renderFormulario('formularioCaptura', esquema, async (valores) => {
              const res = await backend.registrar(valores);
              if (res) { refrescar(); cerrarPanelLateral(); }
              return res;
            }, {
              puedeCrear,
              obtenerUltimoError: backend.ultimoError,
              onAccionExtra: (evento) => {
                if (evento === 'nuevoCliente') {
                  abrirFormularioClienteRapido(body, async () => {
                    Object.assign(esquema, await esquemaConOpcionesFrescas());
                    dibujarFormularioVenta();
                  });
                }
              }
            });
          }
          dibujarFormularioVenta();
        }
      });
    });
  }

  // 4.5: ni siquiera debería aparecer el botón de importar si no puede crear.
  // (antes esto buscaba un contenedor ".captura-importar" que ya no existe
  // desde que el header de "Registros" se reorganizó; ahora se esconde el
  // botón directamente.)
  const btnImportarCSVDB = document.getElementById('btnImportarCSVDB');
  if (!puedeCrear && btnImportarCSVDB) btnImportarCSVDB.style.display = 'none';

  document.getElementById('btnImportarCSVDB').addEventListener('click', () => document.getElementById('fileInputImportDB').click());
  document.getElementById('fileInputImportDB').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const statusEl = document.getElementById('importDBStatus');
    statusEl.textContent = 'Importando…';
    statusEl.style.color = 'var(--muted)';
    const res = await backend.importarCSV(file);
    if (!res) {
      statusEl.textContent = 'No se pudo importar el archivo.';
      statusEl.style.color = 'var(--coral)';
      return;
    }
    statusEl.textContent = `Importadas ${res.insertadas} fila(s)` + (res.errores ? `, ${res.errores} con error.` : '.');
    statusEl.style.color = res.errores ? 'var(--ochre-deep)' : 'var(--teal-strong)';
    refrescar();
  });

  // Exportación a CSV (Nivel 3, Parte A). El botón se crea acá, no en cada
  // HTML, para que los ~30 módulos lo tengan sin tocar sus páginas. Pide las
  // filas frescas con el mismo rango de fechas de los filtros -- y por ser el
  // mismo GET que llena la tabla, el alcance (empresa, sucursal, permisos) es
  // idéntico al de lo que el usuario ya puede ver.
  if (tienePermiso(`${NAMESPACE}.ver`)) {
    const btnExportar = document.createElement('button');
    btnExportar.type = 'button';
    btnExportar.className = 'btn btn-ghost';
    btnExportar.id = 'btnExportarCSVDB';
    btnExportar.textContent = 'Exportar CSV';
    document.getElementById('btnImportarCSVDB').insertAdjacentElement('afterend', btnExportar);

    btnExportar.addEventListener('click', async () => {
      const statusEl = document.getElementById('importDBStatus');
      const filtros = {
        desde: document.getElementById('fechaDesde').value || undefined,
        hasta: document.getElementById('fechaHasta').value || undefined
      };
      btnExportar.disabled = true;
      statusEl.textContent = 'Preparando exportación…';
      statusEl.style.color = 'var(--muted)';

      const filas = await backend.listarCrudo(filtros);
      btnExportar.disabled = false;

      if (!filas.length) {
        // listarCrudo devuelve [] tanto si no hay datos como si la llamada
        // falló -- ultimoError() distingue una cosa de la otra.
        const motivo = backend.ultimoError();
        statusEl.textContent = motivo ? `No se pudo exportar: ${motivo}` : 'No hay registros para exportar en este rango de fechas.';
        statusEl.style.color = motivo ? 'var(--coral)' : 'var(--muted)';
        return;
      }

      exportarFilasCSV({ filas, columnas: backend.esquema.columnasTabla, modulo: NAMESPACE, filtros });
      const truncado = filas.length >= LIMITE_FILAS_EXPORT;
      statusEl.textContent = `Exportadas ${filas.length} fila(s)` +
        (truncado ? `. Es el máximo por exportación: acota el rango de fechas para exportar el resto.` : '.');
      statusEl.style.color = truncado ? 'var(--ochre-deep)' : 'var(--teal-strong)';
    });
  }

  await refrescarTablaBackend();
}

async function refrescarTablaBackend() {
  if (!backendActivo) return;
  const filas = await backendActivo.listarCrudo({
    desde: document.getElementById('fechaDesde').value || undefined,
    hasta: document.getElementById('fechaHasta').value || undefined
  });
  renderTabla('tablaCaptura', filas, backendActivo.esquema, {
    onGuardarEdicion: async (id, cambios) => {
      const res = await backendActivo.actualizar(id, cambios);
      if (res) refrescarDesdeBackend();
      return res;
    },
    onBorrar: async (id) => {
      const ok = await backendActivo.borrar(id);
      if (ok) refrescarDesdeBackend();
      return ok;
    },
    puedeEditar: tienePermiso(`${NAMESPACE}.editar`),
    puedeBorrar: tienePermiso(`${NAMESPACE}.eliminar`),
    terminoInicial: terminoBusquedaPendiente
  });
}

async function iniciar() {
  const config = await cargarConfigEmpresa();

  // Login obligatorio, pero solo para los módulos que sí tienen backend
  // (baseDeDatos:true en company.json). Compras/RRHH/Producción/Marketing
  // todavía no tienen cuentas ni base de datos propia, así que se quedan
  // libres como hasta ahora.
  const moduloActual = buscarModulo(config, NAMESPACE);
  if (moduloActual?.baseDeDatos) {
    // Se lee ANTES de haySesionActiva() -- esa función limpia la sesión
    // como efecto secundario si el token venció (ver sesion.js), así que
    // acá es la última oportunidad de saber si HABÍA una sesión guardada,
    // para distinguir "nunca inició sesión" de "su sesión venció" y mostrar
    // el mensaje correcto en login.html (sub-bloque B1, Fase 3 Eje B).
    const habiaSesionGuardada = !!obtenerSesion()?.token;
    if (!haySesionActiva()) {
      location.replace(habiaSesionGuardada ? 'login.html?expirado=true' : 'login.html');
      return;
    }
  }

  renderSidebar(config, NAMESPACE);
  renderGealmiAiWidget(config);
  aplicarBranding(config);
  await renderTopbar(config);
  renderFooter();
  wireEventos();

  if (moduloActual?.baseDeDatos) {
    // Este módulo vive en la base de datos: cualquier CSV/ZIP guardado
    // localmente de antes de conectarlo al backend (Fase 3) ya no aplica.
    // Se descarta en vez de mostrarlo, para no pintar datos viejos/de ejemplo
    // un instante antes de que lleguen los reales.
    borrarDatosLocal(NAMESPACE);
    mostrarEstado('Cargando datos…', 'info');

    terminoBusquedaPendiente = sessionStorage.getItem('pd_busqueda_pendiente') || '';
    if (terminoBusquedaPendiente) sessionStorage.removeItem('pd_busqueda_pendiente');
  } else {
    restaurarDatosLocalSiExisten();
    refrescar();
  }

  await activarCapturaSiCorresponde(config);
  terminoBusquedaPendiente = '';
}

iniciar();
