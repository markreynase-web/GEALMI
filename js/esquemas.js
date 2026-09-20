// js/esquemas.js
// Un esquema por módulo conectado a base de datos: de aquí sale el formulario
// de captura, la tabla con editar/borrar, y el mapeo hacia el motor de
// dashboard genérico (dashboard.js) que ya existía desde la Fase 1.
//
// Migrar un módulo nuevo a base de datos es, del lado del frontend: agregar
// su entrada aquí + su tabla/rutas en el backend (ver backend/src/routes/).
// Nada más necesita cambiar.

export const ESQUEMAS = {
  ventas: {
    etiqueta: 'venta',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      // 'cliente_id' y 'producto_id' son selects: sus opciones NO se listan
      // aquí (son estáticas para todos), sino que app.js las llena en el
      // momento de abrir el formulario, pidiéndolas frescas al backend
      // (GET /clientes, GET /inventario). Ver poblarSelectsVentas() en app.js.
      { id: 'cliente_id', label: 'Cliente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un cliente…', accionExtra: { texto: '+ Nuevo cliente', evento: 'nuevoCliente' } },
      // buscar:true -- con inventarios grandes (100s/1000s de productos), un
      // <select> con todas las opciones se vuelve inmanejable. En vez de
      // opciones precargadas, este campo se resuelve por búsqueda en vivo
      // contra el backend (ver componentes/comboboxBusqueda.js). fuente,
      // ayudaStock y sugiere se siguen leyendo igual -- buscar:true solo
      // cambia CÓMO se resuelven las opciones, no qué información usa el
      // campo una vez elegido un producto.
      { id: 'producto_id', label: 'Producto', type: 'select', required: true, fuente: 'inventario',
        vacio: 'Selecciona un producto…', ayudaStock: true, sugiere: ['categoria', 'precio_unitario'],
        buscar: true, placeholderBusqueda: 'Buscar producto por nombre o categoría…' },
      // categoria/precio_unitario: vueltos a ser MANUALES a pedido (antes se
      // tomaban solos del catálogo). Al elegir un producto se sugieren con
      // los valores de su ficha en Inventario (ver 'sugiere' arriba y su uso
      // en components/formularioRegistro.js), pero quedan editables.
      { id: 'categoria', label: 'Categoría', type: 'select', fuente: 'categoriasInventario', vacio: 'Selecciona una categoría…' },
      { id: 'cantidad', label: 'Cantidad', type: 'number', required: true, defecto: 1, min: 0.01, step: '0.01' },
      { id: 'precio_unitario', label: 'Precio unitario', type: 'number', required: true, min: 0.01, step: '0.01' },
      // Marketing (paso 9): atribuye la venta a una campaña activa. Solo aparece si la
      // empresa tiene el módulo (requiereModulo, ver esquemaConOpcionesFrescas en app.js).
      { id: 'campana_id', label: 'Campaña', type: 'select', fuente: 'marketing/campanas-activas', vacio: 'Sin campaña', requiereModulo: 'marketing' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente', label: 'Cliente', soloLectura: true },
      { key: 'producto', label: 'Producto', soloLectura: true }, { key: 'categoria', label: 'Categoría' },
      { key: 'cantidad', label: 'Cant.' }, { key: 'precio_unitario', label: 'P. unit.' },
      { key: 'monto', label: 'Monto', soloLectura: true }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto', otrosNum: ['cantidad'], colCat1: 'producto', colCat2: 'categoria', otrasCat: ['cliente'] }
  },

  finanzas: {
    etiqueta: 'movimiento',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'tipo', label: 'Tipo', type: 'select', required: true,
        opciones: [{ value: 'ingreso', label: 'Ingreso' }, { value: 'egreso', label: 'Egreso' }] },
      { id: 'categoria', label: 'Categoría', type: 'text', placeholder: 'Ej. Proveedores, Alquiler…' },
      { id: 'concepto', label: 'Concepto', type: 'text', required: true, ancho: 2 },
      { id: 'monto', label: 'Monto', type: 'number', required: true, min: 0, step: '0.01' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'tipo', label: 'Tipo' },
      { key: 'categoria', label: 'Categoría' }, { key: 'concepto', label: 'Concepto' },
      { key: 'monto', label: 'Monto' }, { key: 'origen_modulo', label: 'Origen' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto', otrosNum: [], colCat1: 'tipo', colCat2: 'categoria', otrasCat: [] }
  },

  inventario: {
    etiqueta: 'producto',
    // Cuando stock <= stock_minimo, la tabla resalta la fila (ver
    // tablaRegistros.js). No bloquea nada por sí solo -- Ventas ya bloquea
    // en 0 -- esto es el aviso temprano de "se está por acabar".
    alertaStock: { campo: 'stock', minimo: 'stock_minimo' },
    campos: [
      { id: 'fecha_registro', label: 'Fecha', type: 'date', required: true },
      { id: 'nombre', label: 'Producto', type: 'text', required: true },
      // Sub-fase F: el stock ya es por sucursal desde la Sub-fase B (cada
      // fila de inventario pertenece a UNA sola sucursal) -- el backend
      // (POST /api/inventario) ya lo exige; esto es lo que le agrega el
      // selector al formulario. Mismo mecanismo que cliente_id/producto_id
      // en Ventas (fuente + CONSTRUCTORES_OPCION en js/app.js), nada nuevo.
      { id: 'sucursal_id', label: 'Sucursal', type: 'select', required: true, fuente: 'sucursales', vacio: 'Selecciona una sucursal…' },
      { id: 'categoria', label: 'Categoría', type: 'text', placeholder: 'Opcional' },
      { id: 'stock', label: 'Stock', type: 'number', required: true, defecto: 0, min: 0, step: '0.01' },
      { id: 'stock_minimo', label: 'Stock mínimo', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'costo_unitario', label: 'Costo de compra (unitario)', type: 'number', min: 0, step: '0.01', placeholder: 'Lo que pagaste por unidad' },
      { id: 'precio_unitario', label: 'Precio de venta (unitario)', type: 'number', min: 0, step: '0.01' },
      { id: 'fecha_vencimiento', label: 'Fecha de vencimiento', type: 'date', placeholder: 'Opcional' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_registro', label: 'Fecha' }, { key: 'nombre', label: 'Producto' },
      { key: 'categoria', label: 'Categoría' }, { key: 'stock', label: 'Stock' },
      { key: 'stock_minimo', label: 'Stock mín.' }, { key: 'costo_unitario', label: 'Costo compra' },
      { key: 'precio_unitario', label: 'P. venta' }, { key: 'fecha_vencimiento', label: 'Vence' }
    ],
    mapa: { colFecha: 'fecha_registro', colNum: 'stock', otrosNum: ['precio_unitario', 'costo_unitario', 'stock_minimo'], colCat1: 'nombre', colCat2: 'categoria', otrasCat: [] }
  },

  clientes: {
    etiqueta: 'cliente',
    // Habilita el botón de acción "WhatsApp" en tablaRegistros.js -- lee el
    // teléfono del campo indicado, sin duplicar el dato en ningún lado. Es
    // un flag a nivel de esquema (no de campo) porque no cambia cómo se
    // captura/valida el teléfono, solo qué acciones aparecen en la tabla.
    // Cualquier otro módulo con su propio campo de teléfono (ej.
    // conductores) puede sumar la misma línea más adelante sin tocar
    // tablaRegistros.js.
    whatsapp: { campoTelefono: 'telefono' },
    campos: [
      { id: 'fecha_registro', label: 'Fecha', type: 'date', required: true },
      { id: 'nombre', label: 'Nombre', type: 'text', required: true },
      { id: 'email', label: 'Email', type: 'email', placeholder: 'Opcional' },
      { id: 'telefono', label: 'Teléfono', type: 'text', placeholder: 'Opcional' },
      { id: 'direccion', label: 'Dirección', type: 'text', placeholder: 'Opcional' },
      { id: 'compras_totales', label: 'Compras totales', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_registro', label: 'Fecha' }, { key: 'nombre', label: 'Nombre' },
      { key: 'email', label: 'Email' }, { key: 'telefono', label: 'Teléfono' },
      { key: 'compras_totales', label: 'Compras' }
    ],
    mapa: { colFecha: 'fecha_registro', colNum: 'compras_totales', otrosNum: [], colCat1: 'nombre', colCat2: 'direccion', otrasCat: [] }
  },

  // --- Fase C: vertical automotriz ---

  vehiculos: {
    etiqueta: 'vehículo',
    campos: [
      { id: 'fecha_registro', label: 'Fecha de registro', type: 'date', required: true },
      { id: 'cliente_id', label: 'Cliente (propietario)', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un cliente…', accionExtra: { texto: '+ Nuevo cliente', evento: 'nuevoCliente' } },
      { id: 'placa', label: 'Placa', type: 'text', required: true },
      { id: 'marca', label: 'Marca', type: 'text', required: true },
      { id: 'modelo', label: 'Modelo', type: 'text', required: true },
      { id: 'anio', label: 'Año', type: 'number', min: 1950, step: '1', placeholder: 'Opcional' },
      { id: 'vin', label: 'VIN', type: 'text', placeholder: 'Opcional' },
      { id: 'color', label: 'Color', type: 'text', placeholder: 'Opcional' },
      { id: 'kilometraje_actual', label: 'Kilometraje actual', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_registro', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Cliente', soloLectura: true },
      { key: 'placa', label: 'Placa' }, { key: 'marca', label: 'Marca' }, { key: 'modelo', label: 'Modelo' },
      { key: 'anio', label: 'Año' }, { key: 'kilometraje_actual', label: 'Kilometraje' }
    ],
    mapa: { colFecha: 'fecha_registro', colCat1: 'marca', colCat2: 'modelo', otrasCat: ['cliente_nombre'] }
  },

  repuestos: {
    etiqueta: 'repuesto',
    alertaStock: { campo: 'stock', minimo: 'stock_minimo' },
    campos: [
      { id: 'fecha_registro', label: 'Fecha', type: 'date', required: true },
      { id: 'nombre', label: 'Repuesto', type: 'text', required: true },
      { id: 'codigo_oem', label: 'Código OEM', type: 'text', placeholder: 'Opcional' },
      { id: 'compatibilidad', label: 'Compatibilidad', type: 'text', ancho: 2, placeholder: 'Ej. Toyota Corolla 2015-2020' },
      { id: 'ubicacion', label: 'Ubicación en almacén', type: 'text', placeholder: 'Opcional' },
      { id: 'proveedor', label: 'Proveedor', type: 'text', placeholder: 'Opcional' },
      { id: 'tiempo_reposicion_dias', label: 'Tiempo de reposición (días)', type: 'number', min: 0, step: '1', placeholder: 'Opcional' },
      { id: 'equivalencias', label: 'Equivalencias', type: 'text', ancho: 2, placeholder: 'Opcional' },
      { id: 'stock', label: 'Stock', type: 'number', required: true, defecto: 0, min: 0, step: '0.01' },
      { id: 'stock_minimo', label: 'Stock mínimo', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'costo_unitario', label: 'Costo de compra (unitario)', type: 'number', min: 0, step: '0.01', placeholder: 'Lo que pagaste por unidad' },
      { id: 'precio_unitario', label: 'Precio de venta (unitario)', type: 'number', required: true, min: 0, step: '0.01' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_registro', label: 'Fecha' }, { key: 'nombre', label: 'Repuesto' },
      { key: 'codigo_oem', label: 'Código OEM' }, { key: 'stock', label: 'Stock' },
      { key: 'stock_minimo', label: 'Stock mín.' }, { key: 'costo_unitario', label: 'Costo compra' },
      { key: 'precio_unitario', label: 'P. venta' }, { key: 'proveedor', label: 'Proveedor' }
    ],
    mapa: { colFecha: 'fecha_registro', colNum: 'stock', otrosNum: ['precio_unitario', 'costo_unitario', 'stock_minimo'], colCat1: 'nombre', colCat2: 'proveedor', otrasCat: [] }
  },

  postventa: {
    etiqueta: 'orden de servicio',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Cliente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un cliente…', accionExtra: { texto: '+ Nuevo cliente', evento: 'nuevoCliente' } },
      { id: 'vehiculo_id', label: 'Vehículo', type: 'select', required: true, fuente: 'vehiculos', vacio: 'Selecciona un vehículo…' },
      { id: 'tipo', label: 'Tipo', type: 'select', required: true,
        opciones: [
          { value: 'mantenimiento', label: 'Mantenimiento' }, { value: 'garantia', label: 'Garantía' },
          { value: 'reparacion', label: 'Reparación' }, { value: 'revision', label: 'Revisión' }
        ] },
      { id: 'kilometraje', label: 'Kilometraje', type: 'number', min: 0, step: '1', placeholder: 'Opcional' },
      { id: 'descripcion', label: 'Descripción del trabajo', type: 'text', required: true, ancho: 2 },
      // repuesto_id es OPCIONAL a propósito -- una orden puede ser solo mano
      // de obra. Si se elige, descuenta stock (igual que ventas.producto_id)
      // y sugiere costo_repuestos con el precio unitario -- que queda
      // editable para cubrir órdenes con más de un repuesto.
      { id: 'repuesto_id', label: 'Repuesto principal', type: 'select', fuente: 'repuestos',
        vacio: 'Ninguno / varios (usa Costo de repuestos manual)',
        ayudaStock: true, ayudaStockCampoCantidad: 'cantidad_repuesto', sugiere: ['costo_repuestos'] },
      { id: 'cantidad_repuesto', label: 'Cantidad de repuesto', type: 'number', defecto: 1, min: 0.01, step: '0.01' },
      { id: 'costo_repuestos', label: 'Costo de repuestos', type: 'number', required: true, defecto: 0, min: 0, step: '0.01' },
      { id: 'mano_obra', label: 'Mano de obra', type: 'number', required: true, defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pendiente',
        opciones: [
          { value: 'pendiente', label: 'Pendiente' }, { value: 'en_proceso', label: 'En proceso' }, { value: 'completado', label: 'Completado' }
        ] },
      { id: 'proximo_servicio', label: 'Próximo servicio', type: 'date', placeholder: 'Opcional' },
      { id: 'garantia_hasta', label: 'Garantía hasta', type: 'date', placeholder: 'Opcional' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Cliente', soloLectura: true },
      { key: 'vehiculo_descripcion', label: 'Vehículo', soloLectura: true }, { key: 'tipo', label: 'Tipo' },
      { key: 'descripcion', label: 'Trabajo' }, { key: 'repuesto_nombre', label: 'Repuesto', soloLectura: true },
      { key: 'costo_repuestos', label: 'Costo rep.' }, { key: 'mano_obra', label: 'M. obra' },
      { key: 'total', label: 'Total', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    // colNum:'total' + colCat1:'estado' -- el KPI principal es ingreso de
    // postventa, y el desglose por categoría muestra cuánto hay en cada
    // estado (pendiente/en_proceso/completado) en vez de solo un conteo.
    mapa: { colFecha: 'fecha', colNum: 'total', otrosNum: ['mano_obra', 'costo_repuestos'], colCat1: 'estado', colCat2: 'tipo', otrasCat: ['cliente_nombre'] }
  },

  // --- Agenda/Citas: capacidad transversal, no atada a un vertical ---

  agenda: {
    etiqueta: 'cita',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'hora', label: 'Hora', type: 'time', required: true },
      { id: 'duracion_minutos', label: 'Duración (minutos)', type: 'number', defecto: 30, min: 5, step: '5' },
      { id: 'cliente_id', label: 'Cliente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un cliente…', accionExtra: { texto: '+ Nuevo cliente', evento: 'nuevoCliente' } },
      { id: 'motivo', label: 'Motivo de la cita', type: 'text', required: true, ancho: 2, placeholder: 'Ej. Limpieza dental, cambio de aceite…' },
      // Opcional a propósito -- solo aplica si la empresa tiene el vertical
      // Automotriz habilitado. En cualquier otro rubro se deja vacío.
      { id: 'vehiculo_id', label: 'Vehículo (opcional)', type: 'select', fuente: 'vehiculos', vacio: 'No aplica / ninguno' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pendiente',
        opciones: [
          { value: 'pendiente', label: 'Pendiente' }, { value: 'confirmada', label: 'Confirmada' },
          { value: 'completada', label: 'Completada' }, { value: 'cancelada', label: 'Cancelada' },
          { value: 'no_asistio', label: 'No asistió' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'hora', label: 'Hora' },
      { key: 'cliente_nombre', label: 'Cliente', soloLectura: true }, { key: 'motivo', label: 'Motivo' },
      { key: 'vehiculo_descripcion', label: 'Vehículo', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colCat1: 'estado', colCat2: 'motivo', otrasCat: ['cliente_nombre'] }
  },

  // --- Vertical Dentista: reutiliza clientes como pacientes ---

  tratamientos: {
    etiqueta: 'tratamiento',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'procedimiento', label: 'Procedimiento', type: 'text', required: true, ancho: 2, placeholder: 'Ej. Limpieza dental, extracción, resina…' },
      { id: 'pieza_dental', label: 'Pieza dental (opcional)', type: 'text', placeholder: 'Ej. 16, muela superior derecha…' },
      { id: 'codigo_procedimiento', label: 'Código (opcional)', type: 'text', placeholder: 'Ej. D1110' },
      { id: 'diagnostico', label: 'Diagnóstico', type: 'text', ancho: 2, placeholder: 'Opcional' },
      { id: 'costo', label: 'Costo', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'planificado',
        opciones: [
          { value: 'planificado', label: 'Planificado' }, { value: 'en_progreso', label: 'En progreso' },
          { value: 'completado', label: 'Completado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'procedimiento', label: 'Procedimiento' }, { key: 'pieza_dental', label: 'Pieza' },
      { key: 'costo', label: 'Costo' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'costo', colCat1: 'procedimiento', colCat2: 'estado', otrasCat: ['cliente_nombre'] }
  },

  planes_tratamiento: {
    etiqueta: 'plan de tratamiento',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'descripcion', label: 'Descripción del plan (fases)', type: 'text', required: true, ancho: 2, placeholder: 'Ej. Fase 1: extracciones. Fase 2: brackets…' },
      { id: 'presupuesto_total', label: 'Presupuesto total', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'propuesto',
        opciones: [
          { value: 'propuesto', label: 'Propuesto' }, { value: 'aprobado', label: 'Aprobado' },
          { value: 'rechazado', label: 'Rechazado' }, { value: 'en_progreso', label: 'En progreso' },
          { value: 'completado', label: 'Completado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'descripcion', label: 'Descripción' }, { key: 'presupuesto_total', label: 'Presupuesto' },
      { key: 'estado', label: 'Estado' }, { key: 'fecha_aprobacion', label: 'Aprobado el', soloLectura: true }
    ],
    mapa: { colFecha: 'fecha', colNum: 'presupuesto_total', colCat1: 'estado', otrasCat: ['cliente_nombre'] }
  },

  seguros_dentales: {
    etiqueta: 'reclamo',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'aseguradora', label: 'Aseguradora', type: 'text', required: true },
      { id: 'numero_poliza', label: 'N° de póliza', type: 'text', placeholder: 'Opcional' },
      { id: 'tratamiento_id', label: 'Tratamiento asociado (opcional)', type: 'select', fuente: 'tratamientos', vacio: 'Ninguno' },
      { id: 'monto_reclamado', label: 'Monto reclamado', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'monto_cubierto', label: 'Monto cubierto', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'enviado',
        opciones: [
          { value: 'enviado', label: 'Enviado' }, { value: 'en_revision', label: 'En revisión' },
          { value: 'aprobado', label: 'Aprobado' }, { value: 'rechazado', label: 'Rechazado' },
          { value: 'pagado', label: 'Pagado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'aseguradora', label: 'Aseguradora' }, { key: 'monto_reclamado', label: 'Reclamado' },
      { key: 'monto_cubierto', label: 'Cubierto' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto_reclamado', otrosNum: ['monto_cubierto'], colCat1: 'estado', colCat2: 'aseguradora', otrasCat: ['cliente_nombre'] }
  },

  // --- Vertical Oculista: reutiliza clientes como pacientes ---

  recetas_opticas: {
    etiqueta: 'receta',
    campos: [
      { id: 'fecha', label: 'Fecha del examen', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'esfera_od', label: 'Esfera OD', type: 'number', step: '0.25', placeholder: 'Ej. -2.50' },
      { id: 'cilindro_od', label: 'Cilindro OD', type: 'number', step: '0.25', placeholder: 'Opcional' },
      { id: 'eje_od', label: 'Eje OD (0-180°)', type: 'number', min: 0, step: '1', placeholder: 'Opcional' },
      { id: 'esfera_oi', label: 'Esfera OI', type: 'number', step: '0.25', placeholder: 'Ej. -2.25' },
      { id: 'cilindro_oi', label: 'Cilindro OI', type: 'number', step: '0.25', placeholder: 'Opcional' },
      { id: 'eje_oi', label: 'Eje OI (0-180°)', type: 'number', min: 0, step: '1', placeholder: 'Opcional' },
      { id: 'adicion', label: 'Adición', type: 'number', min: 0, step: '0.25', placeholder: 'Opcional (bifocal/progresivo)' },
      { id: 'distancia_pupilar', label: 'Distancia pupilar (mm)', type: 'number', min: 0, step: '0.5', placeholder: 'Opcional' },
      { id: 'diagnostico', label: 'Diagnóstico', type: 'text', ancho: 2, placeholder: 'Opcional' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'esfera_od', label: 'Esf. OD' }, { key: 'cilindro_od', label: 'Cil. OD' }, { key: 'eje_od', label: 'Eje OD' },
      { key: 'esfera_oi', label: 'Esf. OI' }, { key: 'cilindro_oi', label: 'Cil. OI' }, { key: 'eje_oi', label: 'Eje OI' }
    ],
    mapa: { colFecha: 'fecha', otrasCat: ['cliente_nombre'] }
  },

  ordenes_laboratorio: {
    etiqueta: 'orden',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'receta_id', label: 'Receta asociada (opcional)', type: 'select', fuente: 'recetas_opticas', vacio: 'Ninguna' },
      { id: 'armazon', label: 'Armazón', type: 'text', placeholder: 'Ej. Ray-Ban RB2140, negro' },
      { id: 'tipo_lente', label: 'Tipo de lente', type: 'select',
        opciones: [
          { value: 'monofocal', label: 'Monofocal' }, { value: 'bifocal', label: 'Bifocal' },
          { value: 'progresivo', label: 'Progresivo' }, { value: 'contacto', label: 'Lente de contacto' }
        ], vacio: 'Selecciona…' },
      { id: 'laboratorio', label: 'Laboratorio', type: 'text', placeholder: 'Opcional' },
      { id: 'costo', label: 'Costo', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pedido',
        opciones: [
          { value: 'pedido', label: 'Pedido' }, { value: 'en_laboratorio', label: 'En laboratorio' },
          { value: 'listo', label: 'Listo' }, { value: 'entregado', label: 'Entregado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'fecha_estimada_entrega', label: 'Entrega estimada', type: 'date', placeholder: 'Opcional' },
      { id: 'garantia_hasta', label: 'Garantía hasta', type: 'date', placeholder: 'Opcional' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'armazon', label: 'Armazón' }, { key: 'tipo_lente', label: 'Lente' },
      { key: 'costo', label: 'Costo' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'costo', colCat1: 'estado', colCat2: 'tipo_lente', otrasCat: ['cliente_nombre'] }
  },

  seguros_vision: {
    etiqueta: 'reclamo',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'cliente_id', label: 'Paciente', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un paciente…', accionExtra: { texto: '+ Nuevo paciente', evento: 'nuevoCliente' } },
      { id: 'aseguradora', label: 'Aseguradora', type: 'text', required: true },
      { id: 'numero_poliza', label: 'N° de póliza', type: 'text', placeholder: 'Opcional' },
      { id: 'orden_id', label: 'Orden asociada (opcional)', type: 'select', fuente: 'ordenes_laboratorio', vacio: 'Ninguna' },
      { id: 'monto_reclamado', label: 'Monto reclamado', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'monto_cubierto', label: 'Monto cubierto', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'enviado',
        opciones: [
          { value: 'enviado', label: 'Enviado' }, { value: 'en_revision', label: 'En revisión' },
          { value: 'aprobado', label: 'Aprobado' }, { value: 'rechazado', label: 'Rechazado' },
          { value: 'pagado', label: 'Pagado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'cliente_nombre', label: 'Paciente', soloLectura: true },
      { key: 'aseguradora', label: 'Aseguradora' }, { key: 'monto_reclamado', label: 'Reclamado' },
      { key: 'monto_cubierto', label: 'Cubierto' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto_reclamado', otrosNum: ['monto_cubierto'], colCat1: 'estado', colCat2: 'aseguradora', otrasCat: ['cliente_nombre'] }
  },

  // --- Vertical Veterinaria: reutiliza clientes como dueños; a diferencia
  // de Dentista/Óptica, el paciente real es la mascota, así que el resto
  // del vertical selecciona mascota_id, no cliente_id directo. ---

  mascotas: {
    etiqueta: 'mascota',
    campos: [
      { id: 'cliente_id', label: 'Dueño', type: 'select', required: true, fuente: 'clientes',
        vacio: 'Selecciona un dueño…', accionExtra: { texto: '+ Nuevo cliente', evento: 'nuevoCliente' } },
      { id: 'nombre', label: 'Nombre de la mascota', type: 'text', required: true },
      { id: 'especie', label: 'Especie', type: 'text', required: true, placeholder: 'Ej. Perro, Gato, Ave…' },
      { id: 'raza', label: 'Raza', type: 'text', placeholder: 'Opcional' },
      { id: 'sexo', label: 'Sexo', type: 'select',
        opciones: [{ value: 'macho', label: 'Macho' }, { value: 'hembra', label: 'Hembra' }], vacio: 'Selecciona…' },
      { id: 'fecha_nacimiento', label: 'Fecha de nacimiento', type: 'date', placeholder: 'Opcional' },
      { id: 'peso_kg', label: 'Peso (kg)', type: 'number', min: 0, step: '0.1', placeholder: 'Opcional' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'nombre', label: 'Mascota' }, { key: 'cliente_nombre', label: 'Dueño', soloLectura: true },
      { key: 'especie', label: 'Especie' }, { key: 'raza', label: 'Raza' }, { key: 'peso_kg', label: 'Peso (kg)' }
    ],
    mapa: { colFecha: 'creado_el', colCat1: 'especie', colCat2: 'raza', otrasCat: ['cliente_nombre'] }
  },

  atenciones_veterinarias: {
    etiqueta: 'atención',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'mascota_id', label: 'Mascota', type: 'select', required: true, fuente: 'mascotas', vacio: 'Selecciona una mascota…' },
      { id: 'procedimiento', label: 'Procedimiento', type: 'text', required: true, ancho: 2, placeholder: 'Ej. Consulta general, vacuna, cirugía…' },
      { id: 'diagnostico', label: 'Diagnóstico', type: 'text', ancho: 2, placeholder: 'Opcional' },
      { id: 'costo', label: 'Costo', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'planificado',
        opciones: [
          { value: 'planificado', label: 'Planificado' }, { value: 'en_progreso', label: 'En progreso' },
          { value: 'completado', label: 'Completado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'mascota_nombre', label: 'Mascota', soloLectura: true },
      { key: 'procedimiento', label: 'Procedimiento' }, { key: 'costo', label: 'Costo' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'costo', colCat1: 'procedimiento', colCat2: 'estado', otrasCat: ['mascota_nombre'] }
  },

  planes_veterinarios: {
    etiqueta: 'plan',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'mascota_id', label: 'Mascota', type: 'select', required: true, fuente: 'mascotas', vacio: 'Selecciona una mascota…' },
      { id: 'descripcion', label: 'Descripción del plan', type: 'text', required: true, ancho: 2, placeholder: 'Ej. Cirugía de esterilización, tratamiento prolongado…' },
      { id: 'presupuesto_total', label: 'Presupuesto total', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'propuesto',
        opciones: [
          { value: 'propuesto', label: 'Propuesto' }, { value: 'aprobado', label: 'Aprobado' },
          { value: 'rechazado', label: 'Rechazado' }, { value: 'en_progreso', label: 'En progreso' },
          { value: 'completado', label: 'Completado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'mascota_nombre', label: 'Mascota', soloLectura: true },
      { key: 'descripcion', label: 'Descripción' }, { key: 'presupuesto_total', label: 'Presupuesto' },
      { key: 'estado', label: 'Estado' }, { key: 'fecha_aprobacion', label: 'Aprobado el', soloLectura: true }
    ],
    mapa: { colFecha: 'fecha', colNum: 'presupuesto_total', colCat1: 'estado', otrasCat: ['mascota_nombre'] }
  },

  seguros_mascotas: {
    etiqueta: 'reclamo',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'mascota_id', label: 'Mascota', type: 'select', required: true, fuente: 'mascotas', vacio: 'Selecciona una mascota…' },
      { id: 'aseguradora', label: 'Aseguradora', type: 'text', required: true },
      { id: 'numero_poliza', label: 'N° de póliza', type: 'text', placeholder: 'Opcional' },
      { id: 'atencion_id', label: 'Atención asociada (opcional)', type: 'select', fuente: 'atenciones_veterinarias', vacio: 'Ninguna' },
      { id: 'monto_reclamado', label: 'Monto reclamado', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'monto_cubierto', label: 'Monto cubierto', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'enviado',
        opciones: [
          { value: 'enviado', label: 'Enviado' }, { value: 'en_revision', label: 'En revisión' },
          { value: 'aprobado', label: 'Aprobado' }, { value: 'rechazado', label: 'Rechazado' },
          { value: 'pagado', label: 'Pagado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'mascota_nombre', label: 'Mascota', soloLectura: true },
      { key: 'aseguradora', label: 'Aseguradora' }, { key: 'monto_reclamado', label: 'Reclamado' },
      { key: 'monto_cubierto', label: 'Cubierto' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto_reclamado', otrosNum: ['monto_cubierto'], colCat1: 'estado', colCat2: 'aseguradora', otrasCat: ['mascota_nombre'] }
  },

  // --- Vertical Transporte de colectivos: NO reutiliza clientes/agenda --
  // esta empresa administra su propia flota, no pacientes/dueños. ---

  flota: {
    etiqueta: 'unidad',
    campos: [
      { id: 'placa', label: 'Placa', type: 'text', required: true },
      { id: 'marca', label: 'Marca', type: 'text', required: true },
      { id: 'modelo', label: 'Modelo', type: 'text', required: true },
      { id: 'anio', label: 'Año', type: 'number', min: 1980, step: '1', placeholder: 'Opcional' },
      { id: 'tipo_vehiculo', label: 'Tipo', type: 'select',
        opciones: [
          { value: 'bus', label: 'Bus' }, { value: 'minibus', label: 'Minibús' },
          { value: 'combi', label: 'Combi' }, { value: 'van', label: 'Van' }
        ], vacio: 'Selecciona…' },
      { id: 'capacidad_pasajeros', label: 'Capacidad (pasajeros)', type: 'number', min: 1, step: '1', placeholder: 'Opcional' },
      { id: 'kilometraje_actual', label: 'Kilometraje actual', type: 'number', defecto: 0, min: 0, step: '1' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'operativo',
        opciones: [
          { value: 'operativo', label: 'Operativo' }, { value: 'mantenimiento', label: 'En mantenimiento' },
          { value: 'fuera_de_servicio', label: 'Fuera de servicio' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'placa', label: 'Placa' }, { key: 'marca', label: 'Marca' }, { key: 'modelo', label: 'Modelo' },
      { key: 'tipo_vehiculo', label: 'Tipo' }, { key: 'kilometraje_actual', label: 'Kilometraje' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'creado_el', colCat1: 'tipo_vehiculo', colCat2: 'estado', otrasCat: ['marca'] }
  },

  conductores: {
    etiqueta: 'conductor',
    campos: [
      { id: 'nombre', label: 'Nombre', type: 'text', required: true },
      { id: 'documento_identidad', label: 'DNI', type: 'text', placeholder: 'Opcional' },
      { id: 'telefono', label: 'Teléfono', type: 'text', placeholder: 'Opcional' },
      { id: 'licencia_categoria', label: 'Categoría de licencia', type: 'text', placeholder: 'Ej. A-IIIb' },
      { id: 'licencia_numero', label: 'N° de licencia', type: 'text', placeholder: 'Opcional' },
      { id: 'licencia_vencimiento', label: 'Licencia vence el', type: 'date', placeholder: 'Opcional' },
      { id: 'fecha_ingreso', label: 'Fecha de ingreso', type: 'date', placeholder: 'Opcional' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'activo',
        opciones: [
          { value: 'activo', label: 'Activo' }, { value: 'inactivo', label: 'Inactivo' }, { value: 'de_baja', label: 'De baja' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'nombre', label: 'Conductor' }, { key: 'licencia_categoria', label: 'Categoría' },
      { key: 'licencia_vencimiento', label: 'Licencia vence' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'creado_el', colCat1: 'estado', otrasCat: ['licencia_categoria'] }
  },

  rutas: {
    etiqueta: 'ruta',
    campos: [
      { id: 'nombre', label: 'Nombre de la ruta', type: 'text', required: true, placeholder: 'Ej. Ruta 12' },
      { id: 'origen', label: 'Origen', type: 'text', placeholder: 'Opcional' },
      { id: 'destino', label: 'Destino', type: 'text', placeholder: 'Opcional' },
      { id: 'distancia_km', label: 'Distancia (km)', type: 'number', min: 0, step: '0.1', placeholder: 'Opcional' },
      { id: 'tarifa', label: 'Tarifa', type: 'number', defecto: 0, min: 0, step: '0.1' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'activa',
        opciones: [{ value: 'activa', label: 'Activa' }, { value: 'inactiva', label: 'Inactiva' }] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'nombre', label: 'Ruta' }, { key: 'origen', label: 'Origen' }, { key: 'destino', label: 'Destino' },
      { key: 'tarifa', label: 'Tarifa' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'creado_el', colNum: 'tarifa', colCat1: 'estado', otrasCat: ['origen', 'destino'] }
  },

  turnos: {
    etiqueta: 'turno',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'conductor_id', label: 'Conductor', type: 'select', required: true, fuente: 'conductores', vacio: 'Selecciona un conductor…' },
      { id: 'flota_id', label: 'Unidad', type: 'select', required: true, fuente: 'flota', vacio: 'Selecciona una unidad…' },
      { id: 'ruta_id', label: 'Ruta', type: 'select', required: true, fuente: 'rutas', vacio: 'Selecciona una ruta…' },
      { id: 'hora_salida', label: 'Hora de salida', type: 'time', required: true },
      { id: 'hora_llegada_estimada', label: 'Hora de llegada estimada', type: 'time', placeholder: 'Opcional' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'programado',
        opciones: [
          { value: 'programado', label: 'Programado' }, { value: 'en_curso', label: 'En curso' },
          { value: 'completado', label: 'Completado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'hora_salida', label: 'Salida' },
      { key: 'conductor_nombre', label: 'Conductor', soloLectura: true }, { key: 'flota_descripcion', label: 'Unidad', soloLectura: true },
      { key: 'ruta_nombre', label: 'Ruta', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colCat1: 'estado', colCat2: 'ruta_nombre', otrasCat: ['conductor_nombre'] }
  },

  control_documentario: {
    etiqueta: 'documento',
    campos: [
      { id: 'entidad_tipo', label: 'Documento de…', type: 'select', required: true,
        opciones: [{ value: 'vehiculo', label: 'Un vehículo' }, { value: 'conductor', label: 'Un conductor' }], vacio: 'Selecciona…' },
      { id: 'flota_id', label: 'Unidad (si es documento de vehículo)', type: 'select', fuente: 'flota', vacio: 'No aplica' },
      { id: 'conductor_id', label: 'Conductor (si es documento de conductor)', type: 'select', fuente: 'conductores', vacio: 'No aplica' },
      { id: 'tipo_documento', label: 'Tipo de documento', type: 'text', required: true, placeholder: 'Ej. SOAT, Revisión técnica, Licencia de conducir…' },
      { id: 'numero_documento', label: 'N° de documento', type: 'text', placeholder: 'Opcional' },
      { id: 'fecha_emision', label: 'Fecha de emisión', type: 'date', placeholder: 'Opcional' },
      { id: 'fecha_vencimiento', label: 'Fecha de vencimiento', type: 'date', required: true },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'vigente',
        opciones: [{ value: 'vigente', label: 'Vigente' }, { value: 'vencido', label: 'Vencido' }] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'tipo_documento', label: 'Documento' }, { key: 'entidad_descripcion', label: 'De', soloLectura: true },
      { key: 'fecha_vencimiento', label: 'Vence' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha_vencimiento', colCat1: 'estado', colCat2: 'tipo_documento', otrasCat: ['entidad_descripcion'] }
  },

  // --- Vertical Pollería/Restaurante: reutiliza `inventario` como el
  // catálogo de platos/productos (mismo criterio que ventas.producto_id).
  // "combos" no tiene entrada acá -- su formulario (elegir varios productos
  // y cantidades) no encaja en este motor genérico de un campo por fila;
  // tiene su propia página bespoke (ver pages/combos.html). ---

  mesas: {
    etiqueta: 'mesa',
    campos: [
      { id: 'numero', label: 'N° de mesa', type: 'number', required: true, min: 1, step: '1' },
      { id: 'zona', label: 'Zona', type: 'text', placeholder: 'Ej. Salón, Terraza…' },
      { id: 'capacidad', label: 'Capacidad', type: 'number', min: 1, step: '1', placeholder: 'Opcional' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'libre',
        opciones: [
          { value: 'libre', label: 'Libre' }, { value: 'ocupada', label: 'Ocupada' },
          { value: 'reservada', label: 'Reservada' }, { value: 'en_limpieza', label: 'En limpieza' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'numero', label: 'Mesa' }, { key: 'zona', label: 'Zona' },
      { key: 'capacidad', label: 'Capacidad' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'creado_el', colCat1: 'estado', colCat2: 'zona' }
  },

  comandas: {
    etiqueta: 'comanda',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'mesa_id', label: 'Mesa', type: 'select', required: true, fuente: 'mesas', vacio: 'Selecciona una mesa…' },
      { id: 'producto_id', label: 'Producto', type: 'select', required: true, fuente: 'inventario',
        vacio: 'Selecciona un producto…', ayudaStock: true },
      { id: 'cantidad', label: 'Cantidad', type: 'number', required: true, defecto: 1, min: 0.01, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pendiente',
        opciones: [
          { value: 'pendiente', label: 'Pendiente' }, { value: 'en_preparacion', label: 'En preparación' },
          { value: 'listo', label: 'Listo' }, { value: 'entregado', label: 'Entregado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Ej. Sin cebolla' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'mesa_numero', label: 'Mesa', soloLectura: true },
      { key: 'producto_nombre', label: 'Producto', soloLectura: true }, { key: 'cantidad', label: 'Cant.' },
      { key: 'monto', label: 'Monto', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto', otrosNum: ['cantidad'], colCat1: 'estado', colCat2: 'producto_nombre', otrasCat: [] }
  },

  combo_ventas: {
    etiqueta: 'venta de combo',
    campos: [
      { id: 'fecha', label: 'Fecha', type: 'date', required: true },
      { id: 'combo_id', label: 'Combo', type: 'select', required: true, fuente: 'combos', vacio: 'Selecciona un combo…' },
      { id: 'mesa_id', label: 'Mesa (opcional, para llevar si se deja vacío)', type: 'select', fuente: 'mesas', vacio: 'Para llevar / ninguna' },
      { id: 'cantidad', label: 'Cantidad de combos', type: 'number', required: true, defecto: 1, min: 1, step: '1' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pendiente',
        opciones: [
          { value: 'pendiente', label: 'Pendiente' }, { value: 'en_preparacion', label: 'En preparación' },
          { value: 'listo', label: 'Listo' }, { value: 'entregado', label: 'Entregado' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'combo_nombre', label: 'Combo', soloLectura: true },
      { key: 'mesa_numero', label: 'Mesa', soloLectura: true }, { key: 'cantidad', label: 'Cant.' },
      { key: 'monto', label: 'Monto', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'monto', otrosNum: ['cantidad'], colCat1: 'estado', colCat2: 'combo_nombre', otrasCat: [] }
  },

  // --- Vertical Gimnasio: pagos manuales, sin pasarela real (ver
  // migrations/027_gimnasio.sql). Ni "membresias" ni "pagos_membresia" tienen
  // entrada acá -- el semáforo de vencimiento, la acción "Registrar pago" y
  // el hecho de que un pago solo se crea anidado (nunca con un POST suelto,
  // y sin ruta de importación CSV) no encajan en este motor genérico, que
  // asume que todo módulo puede crear/importar libremente. Ambas tienen su
  // propia página bespoke (ver pages/membresias.html). ---

  planes_membresia: {
    etiqueta: 'plan',
    campos: [
      { id: 'nombre', label: 'Nombre del plan', type: 'text', required: true, placeholder: 'Ej. Mensual, Trimestral…' },
      { id: 'duracion_meses', label: 'Duración (meses)', type: 'number', required: true, min: 1, step: '1' },
      { id: 'precio', label: 'Precio', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'activo',
        opciones: [{ value: 'activo', label: 'Activo' }, { value: 'inactivo', label: 'Inactivo' }] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'nombre', label: 'Plan' }, { key: 'duracion_meses', label: 'Duración (meses)' },
      { key: 'precio', label: 'Precio' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'creado_el', colNum: 'precio', colCat1: 'estado' }
  },

  // --- Compras, RRHH, Producción: backend real (antes CSV-import-only) ---

  compras: {
    etiqueta: 'compra',
    campos: [
      { id: 'fecha', label: 'Fecha del pedido', type: 'date', required: true },
      { id: 'proveedor', label: 'Proveedor', type: 'text', required: true },
      { id: 'producto_id', label: 'Producto', type: 'select', required: true, fuente: 'inventario',
        vacio: 'Selecciona un producto…' },
      { id: 'cantidad', label: 'Cantidad', type: 'number', required: true, defecto: 1, min: 0.01, step: '0.01' },
      { id: 'costo_unitario', label: 'Costo unitario', type: 'number', required: true, min: 0, step: '0.01' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'pedido',
        opciones: [
          { value: 'pedido', label: 'Pedido' }, { value: 'recibido', label: 'Recibido' }, { value: 'cancelado', label: 'Cancelado' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha', label: 'Fecha' }, { key: 'proveedor', label: 'Proveedor' },
      { key: 'producto_nombre', label: 'Producto', soloLectura: true }, { key: 'cantidad', label: 'Cant.' },
      { key: 'costo_unitario', label: 'Costo unit.' }, { key: 'total', label: 'Total', soloLectura: true }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha', colNum: 'total', colCat1: 'estado', colCat2: 'proveedor', otrasCat: ['producto_nombre'] }
  },

  rrhh: {
    etiqueta: 'empleado',
    campos: [
      { id: 'fecha_contratacion', label: 'Fecha de contratación', type: 'date', required: true },
      { id: 'nombre', label: 'Nombre completo', type: 'text', required: true },
      { id: 'puesto', label: 'Puesto', type: 'text', placeholder: 'Opcional' },
      { id: 'departamento', label: 'Departamento', type: 'text', placeholder: 'Opcional' },
      { id: 'salario', label: 'Salario', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'email', label: 'Correo', type: 'email', placeholder: 'Opcional' },
      { id: 'telefono', label: 'Teléfono', type: 'text', placeholder: 'Opcional' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'activo',
        opciones: [
          { value: 'activo', label: 'Activo' }, { value: 'inactivo', label: 'Inactivo' },
          { value: 'vacaciones', label: 'Vacaciones' }, { value: 'licencia', label: 'Licencia' }
        ] },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_contratacion', label: 'Contratado' }, { key: 'nombre', label: 'Nombre' },
      { key: 'puesto', label: 'Puesto' }, { key: 'departamento', label: 'Departamento' },
      { key: 'salario', label: 'Salario' }, { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha_contratacion', colNum: 'salario', colCat1: 'departamento', colCat2: 'estado', otrasCat: ['puesto'] }
  },

  produccion: {
    etiqueta: 'orden de producción',
    campos: [
      { id: 'fecha_inicio', label: 'Fecha de inicio', type: 'date', required: true },
      { id: 'producto_id', label: 'Producto a fabricar', type: 'select', required: true, fuente: 'inventario',
        vacio: 'Selecciona un producto…' },
      { id: 'cantidad_planificada', label: 'Cantidad planificada', type: 'number', required: true, min: 0.01, step: '0.01' },
      { id: 'cantidad_producida', label: 'Cantidad producida', type: 'number', defecto: 0, min: 0, step: '0.01', placeholder: 'Se completa al terminar la orden' },
      { id: 'fecha_fin_estimada', label: 'Entrega estimada', type: 'date', placeholder: 'Opcional' },
      { id: 'estado', label: 'Estado', type: 'select', defecto: 'planificada',
        opciones: [
          { value: 'planificada', label: 'Planificada' }, { value: 'en_proceso', label: 'En proceso' },
          { value: 'completada', label: 'Completada' }, { value: 'cancelada', label: 'Cancelada' }
        ] },
      { id: 'costo_materiales', label: 'Costo de materiales', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'costo_mano_obra', label: 'Costo de mano de obra', type: 'number', defecto: 0, min: 0, step: '0.01' },
      { id: 'notas', label: 'Notas', type: 'text', ancho: 2, placeholder: 'Opcional' }
    ],
    columnasTabla: [
      { key: 'fecha_inicio', label: 'Inicio' }, { key: 'producto_nombre', label: 'Producto', soloLectura: true },
      { key: 'cantidad_planificada', label: 'Planificado' }, { key: 'cantidad_producida', label: 'Producido' },
      { key: 'estado', label: 'Estado' }
    ],
    mapa: { colFecha: 'fecha_inicio', colNum: 'cantidad_planificada', otrosNum: ['cantidad_producida'], colCat1: 'estado', colCat2: 'producto_nombre', otrasCat: [] }
  }
};
