// components/footer.js
// Pie de página compartido -- antes cada plantilla de módulo tenía su propio
// <footer> suelto con texto distinto (o ninguno). Un solo lugar para el
// enlace a la política de privacidad, así aparece igual en toda la app.

export function renderFooter() {
  const el = document.querySelector('footer');
  if (!el) return;
  const anio = new Date().getFullYear();
  el.innerHTML = `© ${anio} <b>GEALMI</b> · <a href="privacidad.html">Política de privacidad y tratamiento de datos</a>`;
}
