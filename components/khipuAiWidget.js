// components/khipuAiWidget.js
// Fase D: botón flotante "GEALMI AI" + ventana de chat tipo burbuja
// (Facebook Messenger) -- una ventanita fija que se despliega junto al
// botón, no el panel lateral de ancho completo que usa el resto de la app
// (decisión explícita del usuario: NO reutiliza components/panelLateral.js).

import { buscarModulo } from '../js/config.js';
import { tienePermiso } from '../js/sesion.js';
import { preguntarKhipuAi } from '../js/khipuAi.js';

// Vive en memoria de esta carga de página -- se pierde al recargar, a
// propósito (mismo criterio de "generación en vivo" del resto de la Fase D:
// nada de historial persistido en el servidor).
let historial = [];
let abierta = false;

// Ícono "spark" en vez de emoji 🤖 (Rediseño v3, mismo criterio que
// login/landing: sin emojis como ícono estructural). currentColor hereda el
// color del elemento que lo contiene, así que no necesita su propio CSS.
// Exportado para que components/sidebar.js pinte el mismo ícono en su
// entrada de "GEALMI AI" sin duplicar el path SVG.
export const ICONO_SPARK = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2L11.8 7.4L17 10L11.8 12.6L10 18L8.2 12.6L3 10L8.2 7.4L10 2Z" fill="currentColor"/></svg>';

// Evento global para abrir el chat desde fuera de este módulo (ej. la
// entrada de "GEALMI AI" en el sidebar) sin que sidebar.js tenga que
// importar directo este archivo -- mismo criterio de desacople por eventos
// que ya usa accionExtra en components/formularioRegistro.js. Se registra
// una sola vez al cargar el módulo (top-level, no dentro de una función),
// así no hace falta una bandera de "ya está enganchado".
window.addEventListener('khipu-ai:abrir', () => setVentana(true));

// Preguntas de ejemplo mostradas como chips cuando el chat todavía no tiene
// historial -- clic llena el input y envía, reutilizando el mismo flujo de
// onEnviar (sin duplicar lógica de fetch/render).
//
// Contextuales solo en los módulos donde khipuAiTools.js YA tiene una
// herramienta real (ventas, inventario/repuestos, finanzas, clientes) --
// el resto de los ~25 módulos (Mascotas, Membresías, Flota, Tratamientos...)
// no tiene ninguna herramienta propia todavía, así que un chip prometiendo
// una respuesta sobre "mascotas con seguimiento pendiente" chocaría contra
// un asistente que no tiene con qué contestar eso. Se quedan con las
// genéricas de siempre hasta que existan esas herramientas (backlog aparte).
const SUGERENCIAS_POR_MODULO = {
  ventas: [
    '¿Cómo van las ventas este mes?',
    '¿Cuál es mi ticket promedio?',
    'Compara este mes con el anterior.',
    '¿Cuáles son mis productos más vendidos?'
  ],
  inventario: [
    '¿Qué productos tienen stock bajo?',
    '¿Qué productos casi no se venden?',
    '¿Qué debería reponer pronto?'
  ],
  repuestos: [
    '¿Qué repuestos tienen stock bajo?',
    '¿Qué repuestos casi no se venden?',
    '¿Qué debería reponer pronto?'
  ],
  finanzas: [
    'Dame un resumen financiero.',
    '¿Cuál es mi saldo neto este mes?',
    '¿En qué estoy gastando más?'
  ],
  clientes: [
    '¿Cuál fue mi mejor cliente este mes?',
    '¿Quiénes son mis clientes más frecuentes?'
  ]
};

const PREGUNTAS_SUGERIDAS_GENERICAS = [
  '¿Cómo están las ventas este mes?',
  '¿Qué productos tienen stock bajo?',
  '¿Cuál fue mi mejor cliente?',
  'Genera un resumen financiero.',
  '¿Qué áreas necesitan atención?'
];

function sugerenciasActuales() {
  return SUGERENCIAS_POR_MODULO[document.body.dataset.modulo] || PREGUNTAS_SUGERIDAS_GENERICAS;
}

export function renderKhipuAiWidget(config) {
  const habilitado = !!buscarModulo(config, 'khipu_ai') && tienePermiso('khipu_ai.ver');
  const widget = document.getElementById('khipuAiWidget');

  if (!habilitado) {
    if (widget) widget.remove();
    return;
  }

  asegurarEstilos();
  asegurarWidget();
}

// Igual que asegurarFavicon() en components/sidebar.js: se inyecta una sola
// vez, así ninguna de las páginas de módulo necesita un <link> a mano.
function asegurarEstilos() {
  if (document.querySelector('link[data-khipu-ai-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '../css/khipu-ai-widget.css';
  link.setAttribute('data-khipu-ai-css', '');
  document.head.appendChild(link);
}

function asegurarWidget() {
  if (document.getElementById('khipuAiWidget')) return;

  const wrap = document.createElement('div');
  wrap.id = 'khipuAiWidget';
  wrap.className = 'khipu-ai-widget';
  wrap.innerHTML = `
    <div class="khipu-ai-ventana" id="khipuAiVentana">
      <div class="khipu-ai-ventana-header">
        <span class="khipu-ai-ventana-titulo">${ICONO_SPARK} GEALMI AI</span>
        <button type="button" class="khipu-ai-ventana-cerrar" id="khipuAiCerrar" aria-label="Cerrar">✕</button>
      </div>
      <div class="khipu-ai-mensajes" id="khipuAiMensajes"></div>
      <form class="khipu-ai-form" id="khipuAiForm">
        <input type="text" id="khipuAiInput" placeholder="Pregúntale a GEALMI AI..." autocomplete="off" />
        <button type="submit" class="btn btn-ochre" id="khipuAiEnviarBtn">Enviar</button>
      </form>
    </div>
    <button type="button" class="khipu-ai-boton" id="khipuAiBoton" aria-label="Abrir GEALMI AI"><span>${ICONO_SPARK}</span></button>
  `;
  document.body.appendChild(wrap);

  document.getElementById('khipuAiBoton').addEventListener('click', () => setVentana(!abierta));
  document.getElementById('khipuAiCerrar').addEventListener('click', () => setVentana(false));
  document.getElementById('khipuAiForm').addEventListener('submit', onEnviar);
  document.getElementById('khipuAiMensajes').addEventListener('click', onClickSugerencia);

  renderMensajes();
}

// Delegado en #khipuAiMensajes (los chips se re-crean en cada renderMensajes,
// así que un listener por chip se perdería en cada render -- delegar en el
// contenedor, que sí es estable, evita tener que re-atachar nada).
function onClickSugerencia(e) {
  const chip = e.target.closest('.khipu-ai-chip');
  if (!chip) return;
  const input = document.getElementById('khipuAiInput');
  input.value = chip.textContent;
  document.getElementById('khipuAiForm').requestSubmit();
}

function setVentana(mostrar) {
  abierta = mostrar;
  document.getElementById('khipuAiVentana')?.classList.toggle('activa', abierta);
  document.getElementById('khipuAiBoton')?.classList.toggle('activo', abierta);
  if (abierta) document.getElementById('khipuAiInput')?.focus();
}

function renderMensajes() {
  const cont = document.getElementById('khipuAiMensajes');
  if (!cont) return;

  if (!historial.length) {
    const chips = `<div class="khipu-ai-sugerencias">${sugerenciasActuales().map(p => `<button type="button" class="khipu-ai-chip">${escaparHtml(p)}</button>`).join('')}</div>`;
    cont.innerHTML = `<div class="khipu-ai-msg khipu-ai-msg-asistente">Hola, soy GEALMI AI 👋 Pregúntame sobre tus ventas, inventario, finanzas o clientes.</div>${chips}`;
  } else {
    cont.innerHTML = historial.map(m => {
      const clase = m.rol === 'user' ? 'khipu-ai-msg-user' : 'khipu-ai-msg-asistente';
      const fuentes = m.herramientas?.length
        ? `<div class="khipu-ai-fuentes">Consulté: ${m.herramientas.join(', ')}</div>`
        : '';
      return `<div class="khipu-ai-msg ${clase}">${escaparHtml(m.texto)}${fuentes}</div>`;
    }).join('');
  }
  cont.scrollTop = cont.scrollHeight;
}

// Burbuja de "escribiendo..." (3 puntos animados) insertada directo en el
// flujo de mensajes -- se siente parte de la conversación en vez de un
// texto de estado aparte. Se borra sola en el siguiente renderMensajes()
// (que reconstruye #khipuAiMensajes desde `historial`), así que solo hace
// falta insertarla, no removerla a mano.
function mostrarEscribiendo() {
  const cont = document.getElementById('khipuAiMensajes');
  if (!cont) return;
  cont.insertAdjacentHTML('beforeend', '<div class="khipu-ai-msg khipu-ai-msg-asistente khipu-ai-msg-escribiendo"><span></span><span></span><span></span></div>');
  cont.scrollTop = cont.scrollHeight;
}

async function onEnviar(e) {
  e.preventDefault();
  const input = document.getElementById('khipuAiInput');
  const boton = document.getElementById('khipuAiEnviarBtn');
  const pregunta = input.value.trim();
  if (!pregunta) return;

  historial.push({ rol: 'user', texto: pregunta });
  renderMensajes();
  mostrarEscribiendo();
  input.value = '';
  input.disabled = true;
  boton.disabled = true;

  try {
    const historialParaBackend = historial.slice(0, -1).map(m => ({ rol: m.rol, texto: m.texto }));
    const { respuesta, herramientas_usadas } = await preguntarKhipuAi(pregunta, historialParaBackend);
    historial.push({ rol: 'assistant', texto: respuesta, herramientas: herramientas_usadas });
  } catch (err) {
    historial.push({ rol: 'assistant', texto: `⚠️ ${err.message}` });
  } finally {
    input.disabled = false;
    boton.disabled = false;
    renderMensajes();
    input.focus();
  }
}

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML.replace(/\n/g, '<br>');
}
