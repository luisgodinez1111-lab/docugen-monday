'use strict';
/**
 * src/routes/template-library.routes.js
 * Galería de plantillas prediseñadas — browse, preview, import to account.
 *
 * Templates are defined as canvas_json (fabric.js) + metadata.
 * Import endpoint compiles the canvas_json to DOCX using the same logic as the editor.
 */

const { Router } = require('express');

// ── Template Library Definition ─────────────────────────────────────────────
// Each template has: id, name, category, description, tags, color, icon, canvas_json
// Variables use {{variable}} syntax — replaced at generation time from Monday items.
// Global vars: {{empresa}}, {{rfc}}, {{domicilio}}, {{fecha_hoy}}, {{moneda}}
// Monday vars: {{nombre}}, {{email}}, {{telefono}}, any column mapped via settings

const LIBRARY = [

  // ─── VENTAS ────────────────────────────────────────────────────────────────

  {
    id: 'cotizacion-profesional',
    name: 'Cotización Profesional',
    category: 'ventas',
    description: 'Cotización formal con tabla de productos, subtotales, IVA y total.',
    tags: ['cotización', 'ventas', 'precio'],
    icon: '💰',
    color: '#007AFF',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'{{empresa}}', left:40, top:40, fontSize:22, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:460 },
        { type:'i-text', text:'{{rfc}} | {{telefono_empresa}} | {{email_empresa}}', left:40, top:70, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:460 },
        { type:'i-text', text:'COTIZACIÓN', left:40, top:120, fontSize:28, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:460 },
        { type:'i-text', text:'No. COT-{{nombre}}', left:40, top:158, fontSize:13, fontFamily:'Arial', fill:'#3C3C43', width:300 },
        { type:'i-text', text:'Fecha: {{fecha_hoy}}', left:40, top:178, fontSize:13, fontFamily:'Arial', fill:'#3C3C43', width:300 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:205, stroke:'#E5E5EA', strokeWidth:1.5 },
        { type:'i-text', text:'DATOS DEL CLIENTE', left:40, top:220, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'Cliente: {{nombre}}', left:40, top:240, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'Empresa: {{empresa_cliente}}', left:40, top:258, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'Correo: {{email}}', left:40, top:276, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:305, stroke:'#E5E5EA', strokeWidth:1.5 },
        { type:'i-text', text:'DESCRIPCIÓN DEL SERVICIO / PRODUCTO', left:40, top:320, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:345, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700, textAlign:'left' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:420, stroke:'#E5E5EA', strokeWidth:1.5 },
        { type:'i-text', text:'Subtotal:', left:520, top:440, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:120 },
        { type:'i-text', text:'${{subtotal}}', left:640, top:440, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'IVA ({{iva_pct_display}}):', left:520, top:460, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:120 },
        { type:'i-text', text:'${{iva}}', left:640, top:460, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'TOTAL:', left:520, top:485, fontSize:14, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:120 },
        { type:'i-text', text:'${{total}} {{moneda}}', left:620, top:485, fontSize:14, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:140, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:520, stroke:'#E5E5EA', strokeWidth:1.5 },
        { type:'i-text', text:'Condiciones de pago:', left:40, top:535, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'50% al inicio del proyecto / 50% a la entrega', left:40, top:555, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:500 },
        { type:'i-text', text:'Vigencia de cotización: 30 días naturales', left:40, top:575, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:400 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:640, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Firma del cliente', left:100, top:670, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:160, textAlign:'center' },
        { type:'i-text', text:'Firma autorizada', left:480, top:670, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:160, textAlign:'center' },
        { type:'i-text', text:'{{empresa}} · {{domicilio}}', left:40, top:720, fontSize:10, fontFamily:'Arial', fill:'#AEAEB2', width:700, textAlign:'center' },
      ]
    })
  },

  {
    id: 'propuesta-comercial',
    name: 'Propuesta Comercial',
    category: 'ventas',
    description: 'Propuesta ejecutiva con alcance, entregables, inversión y siguientes pasos.',
    tags: ['propuesta', 'ventas', 'comercial', 'proyecto'],
    icon: '📊',
    color: '#34C759',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'PROPUESTA COMERCIAL', left:40, top:40, fontSize:26, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'Preparada para: {{nombre}} | {{fecha_hoy}}', left:40, top:80, fontSize:13, fontFamily:'Arial', fill:'#6C6C70', width:500 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:105, stroke:'#34C759', strokeWidth:2.5 },
        { type:'i-text', text:'RESUMEN EJECUTIVO', left:40, top:125, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#34C759', width:400 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:148, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'ALCANCE DEL PROYECTO', left:40, top:220, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'• {{entregable_1}}\n• {{entregable_2}}\n• {{entregable_3}}', left:40, top:245, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'INVERSIÓN', left:40, top:340, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'Monto total: ${{total}} {{moneda}} + IVA', left:40, top:365, fontSize:14, fontFamily:'Arial', fontWeight:'bold', fill:'#34C759', width:500 },
        { type:'i-text', text:'Forma de pago: {{forma_pago}}', left:40, top:390, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'SIGUIENTES PASOS', left:40, top:440, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'1. Aprobación de propuesta\n2. Firma de contrato\n3. Pago inicial\n4. Inicio de proyecto', left:40, top:465, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:500 },
        { type:'i-text', text:'Preparado por: {{empresa}}', left:40, top:600, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'{{domicilio}} | {{email_empresa}} | {{telefono_empresa}}', left:40, top:622, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:600 },
      ]
    })
  },

  {
    id: 'orden-compra',
    name: 'Orden de Compra',
    category: 'ventas',
    description: 'Orden de compra oficial con número de folio, proveedor, líneas de productos y condiciones.',
    tags: ['compras', 'proveedor', 'orden', 'OC'],
    icon: '🛒',
    color: '#FF9500',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'{{empresa}}', left:40, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'RFC: {{rfc}}', left:40, top:68, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:300 },
        { type:'i-text', text:'ORDEN DE COMPRA', left:400, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:340, textAlign:'right' },
        { type:'i-text', text:'No. OC-{{nombre}}', left:400, top:68, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:340, textAlign:'right' },
        { type:'i-text', text:'Fecha: {{fecha_hoy}}', left:400, top:86, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:340, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:115, stroke:'#FF9500', strokeWidth:2 },
        { type:'i-text', text:'DATOS DEL PROVEEDOR', left:40, top:130, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'Proveedor: {{nombre}}', left:40, top:152, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'Contacto: {{email}} | {{telefono}}', left:40, top:170, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'LUGAR Y FECHA DE ENTREGA', left:400, top:130, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:340 },
        { type:'i-text', text:'Entregar en: {{domicilio}}', left:400, top:152, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:340 },
        { type:'i-text', text:'Fecha requerida: {{fecha_entrega}}', left:400, top:170, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:340 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:200, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'DESCRIPCIÓN / PRODUCTOS SOLICITADOS', left:40, top:215, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:500 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:240, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:380, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Subtotal:', left:540, top:400, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{subtotal}} {{moneda}}', left:640, top:400, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:140, textAlign:'right' },
        { type:'i-text', text:'IVA:', left:540, top:420, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{iva}} {{moneda}}', left:640, top:420, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:140, textAlign:'right' },
        { type:'i-text', text:'TOTAL OC:', left:540, top:445, fontSize:14, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:100 },
        { type:'i-text', text:'${{total}} {{moneda}}', left:620, top:445, fontSize:14, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:160, textAlign:'right' },
        { type:'i-text', text:'Autorizó:', left:100, top:550, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:160, textAlign:'center' },
        { type:'i-text', text:'Recibió conforme:', left:480, top:550, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:180, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:160, y2:0, left:60, top:540, stroke:'#C7C7CC', strokeWidth:1 },
        { type:'line', x1:0, y1:0, x2:160, y2:0, left:460, top:540, stroke:'#C7C7CC', strokeWidth:1 },
      ]
    })
  },

  // ─── LEGAL ─────────────────────────────────────────────────────────────────

  {
    id: 'contrato-servicios',
    name: 'Contrato de Servicios',
    category: 'legal',
    description: 'Contrato profesional de prestación de servicios con cláusulas estándar, vigencia y condiciones.',
    tags: ['contrato', 'servicios', 'legal', 'acuerdo'],
    icon: '📋',
    color: '#AF52DE',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'CONTRATO DE PRESTACIÓN DE SERVICIOS', left:40, top:40, fontSize:18, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:72, stroke:'#AF52DE', strokeWidth:2 },
        { type:'i-text', text:'En {{domicilio}}, a {{fecha_hoy}}, comparecen:', left:40, top:90, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'EL PRESTADOR DE SERVICIOS:', left:40, top:118, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'{{empresa}}, RFC: {{rfc}}, con domicilio en {{domicilio}}.', left:40, top:138, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'EL CLIENTE:', left:40, top:170, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'{{nombre}}, con correo {{email}}, en lo sucesivo "EL CLIENTE".', left:40, top:190, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:220, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'PRIMERA. OBJETO DEL CONTRATO', left:40, top:235, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#AF52DE', width:500 },
        { type:'i-text', text:'EL PRESTADOR se obliga a proporcionar al CLIENTE los siguientes servicios:', left:40, top:258, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:278, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'SEGUNDA. VIGENCIA', left:40, top:340, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#AF52DE', width:500 },
        { type:'i-text', text:'El presente contrato tendrá vigencia a partir del {{fecha_hoy}} y hasta el cumplimiento del objeto.', left:40, top:362, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'TERCERA. CONTRAPRESTACIÓN', left:40, top:395, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#AF52DE', width:500 },
        { type:'i-text', text:'EL CLIENTE pagará la cantidad de ${{total}} {{moneda}} más IVA correspondiente.\nForma de pago: {{forma_pago}}', left:40, top:417, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'CUARTA. CONFIDENCIALIDAD', left:40, top:462, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#AF52DE', width:500 },
        { type:'i-text', text:'Ambas partes se obligan a guardar confidencialidad sobre la información intercambiada durante\nla prestación de los servicios, durante la vigencia y por 2 años posteriores.', left:40, top:484, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:540, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'EL PRESTADOR', left:100, top:600, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:200, textAlign:'center' },
        { type:'i-text', text:'EL CLIENTE', left:480, top:600, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:200, textAlign:'center' },
        { type:'i-text', text:'{{empresa}}', left:100, top:618, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
        { type:'i-text', text:'{{nombre}}', left:480, top:618, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  {
    id: 'nda',
    name: 'Convenio de Confidencialidad (NDA)',
    category: 'legal',
    description: 'Acuerdo de no divulgación bilateral con cláusulas de penalidades y duración definida.',
    tags: ['NDA', 'confidencialidad', 'acuerdo', 'legal'],
    icon: '🔒',
    color: '#FF3B30',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'ACUERDO DE CONFIDENCIALIDAD', left:40, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'i-text', text:'(Non-Disclosure Agreement — NDA)', left:40, top:68, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:92, stroke:'#FF3B30', strokeWidth:2 },
        { type:'i-text', text:'Celebrado en {{domicilio}}, el día {{fecha_hoy}}, entre:', left:40, top:110, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'PARTE DIVULGANTE: {{empresa}}, RFC {{rfc}}.', left:40, top:135, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'PARTE RECEPTORA: {{nombre}}, correo: {{email}}.', left:40, top:155, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'1. INFORMACIÓN CONFIDENCIAL', left:40, top:190, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#FF3B30', width:500 },
        { type:'i-text', text:'Se considera Información Confidencial toda aquella relacionada con: {{descripcion}},\nassí como cualquier dato técnico, comercial, financiero o estratégico intercambiado.', left:40, top:212, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'2. OBLIGACIONES', left:40, top:265, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#FF3B30', width:500 },
        { type:'i-text', text:'La Parte Receptora se obliga a:\n• No divulgar la información a terceros sin autorización escrita previa.\n• Usar la información exclusivamente para los fines acordados.\n• Proteger la información con medidas de seguridad equivalentes a las propias.', left:40, top:287, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'3. VIGENCIA', left:40, top:360, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#FF3B30', width:500 },
        { type:'i-text', text:'El presente acuerdo tiene vigencia de 2 (dos) años a partir de la fecha de firma.', left:40, top:382, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'4. PENALIDADES', left:40, top:412, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#FF3B30', width:500 },
        { type:'i-text', text:'El incumplimiento dará derecho a la Parte Divulgante a reclamar daños y perjuicios,\nsin perjuicio de las acciones legales que procedan conforme a la legislación aplicable.', left:40, top:434, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:510, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Parte Divulgante\n{{empresa}}', left:100, top:555, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
        { type:'i-text', text:'Parte Receptora\n{{nombre}}', left:480, top:555, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  {
    id: 'contrato-trabajo',
    name: 'Contrato de Trabajo',
    category: 'legal',
    description: 'Contrato laboral con puesto, salario, jornada, prestaciones y cláusulas de terminación.',
    tags: ['laboral', 'trabajo', 'empleado', 'RRHH'],
    icon: '👔',
    color: '#5856D6',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'CONTRATO INDIVIDUAL DE TRABAJO', left:40, top:40, fontSize:18, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'i-text', text:'Por tiempo indeterminado', left:40, top:66, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:88, stroke:'#5856D6', strokeWidth:2 },
        { type:'i-text', text:'En {{domicilio}}, a {{fecha_hoy}}, comparecen:', left:40, top:105, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'PATRÓN: {{empresa}}, representada para estos efectos.', left:40, top:128, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'TRABAJADOR: {{nombre}}, CURP: {{curp}}, correo: {{email}}.', left:40, top:148, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'PRIMERA. PUESTO Y FUNCIONES', left:40, top:182, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'El trabajador desempeñará el puesto de: {{puesto}}\nFunciones principales: {{descripcion}}', left:40, top:204, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'SEGUNDA. JORNADA', left:40, top:260, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'Jornada: Lunes a Viernes, 9:00 a 18:00 hrs. (8 horas diarias).', left:40, top:282, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'TERCERA. SALARIO', left:40, top:312, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'Salario mensual: ${{total}} {{moneda}}, pagado de forma quincenal.', left:40, top:334, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'CUARTA. PRESTACIONES', left:40, top:364, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'Conforme a la Ley Federal del Trabajo: IMSS, INFONAVIT, vacaciones,\nprima vacacional, aguinaldo y demás prestaciones de ley.', left:40, top:386, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:460, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'EL PATRÓN\n{{empresa}}', left:100, top:510, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
        { type:'i-text', text:'EL TRABAJADOR\n{{nombre}}', left:480, top:510, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  // ─── FINANZAS ───────────────────────────────────────────────────────────────

  {
    id: 'factura-simple',
    name: 'Factura / Remisión',
    category: 'finanzas',
    description: 'Documento de cobro con datos fiscales, concepto, subtotal, IVA y total a pagar.',
    tags: ['factura', 'cobro', 'remisión', 'fiscal'],
    icon: '🧾',
    color: '#FF9500',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'{{empresa}}', left:40, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'RFC: {{rfc}}', left:40, top:66, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:300 },
        { type:'i-text', text:'{{domicilio}}', left:40, top:82, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:400 },
        { type:'i-text', text:'FACTURA / REMISIÓN', left:450, top:40, fontSize:18, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:290, textAlign:'right' },
        { type:'i-text', text:'Folio: {{nombre}}', left:450, top:68, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:290, textAlign:'right' },
        { type:'i-text', text:'Fecha: {{fecha_hoy}}', left:450, top:86, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:290, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:110, stroke:'#FF9500', strokeWidth:2 },
        { type:'i-text', text:'FACTURAR A:', left:40, top:125, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'{{nombre}}\n{{email}}\n{{telefono}}', left:40, top:145, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:205, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'CONCEPTO', left:40, top:220, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:500 },
        { type:'i-text', text:'IMPORTE', left:620, top:220, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:120, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:238, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:255, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:540 },
        { type:'i-text', text:'${{subtotal}}', left:620, top:255, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:380, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Subtotal:', left:520, top:398, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{subtotal}}', left:640, top:398, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'IVA {{iva_pct_display}}:', left:520, top:418, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{iva}}', left:640, top:418, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'TOTAL:', left:520, top:445, fontSize:15, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:100 },
        { type:'i-text', text:'${{total}} {{moneda}}', left:620, top:445, fontSize:15, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:140, textAlign:'right' },
        { type:'i-text', text:'Son: {{total_letras}}', left:40, top:448, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:450, fontStyle:'italic' },
      ]
    })
  },

  {
    id: 'recibo-pago',
    name: 'Recibo de Pago',
    category: 'finanzas',
    description: 'Comprobante de pago recibido con concepto, monto, forma de pago y sello.',
    tags: ['recibo', 'pago', 'comprobante'],
    icon: '✅',
    color: '#34C759',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'RECIBO DE PAGO', left:40, top:40, fontSize:26, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:74, stroke:'#34C759', strokeWidth:2.5 },
        { type:'i-text', text:'No. Recibo: REC-{{nombre}}', left:40, top:95, fontSize:13, fontFamily:'Arial', fill:'#3C3C43', width:350 },
        { type:'i-text', text:'Fecha: {{fecha_hoy}}', left:450, top:95, fontSize:13, fontFamily:'Arial', fill:'#3C3C43', width:290, textAlign:'right' },
        { type:'i-text', text:'Recibí de:', left:40, top:130, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:120 },
        { type:'i-text', text:'{{nombre}}', left:165, top:130, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:400 },
        { type:'i-text', text:'La cantidad de:', left:40, top:158, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:130 },
        { type:'i-text', text:'${{total}} {{moneda}}', left:175, top:158, fontSize:16, fontFamily:'Arial', fontWeight:'bold', fill:'#34C759', width:400 },
        { type:'i-text', text:'({{total_letras}})', left:40, top:185, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:700, fontStyle:'italic' },
        { type:'i-text', text:'Concepto:', left:40, top:215, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:110 },
        { type:'i-text', text:'{{descripcion}}', left:155, top:215, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:560 },
        { type:'i-text', text:'Forma de pago:', left:40, top:245, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:140 },
        { type:'i-text', text:'{{forma_pago}}', left:185, top:245, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:300 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:295, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Firma quien recibe', left:480, top:380, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:200, textAlign:'center' },
        { type:'i-text', text:'{{empresa}}', left:480, top:398, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  {
    id: 'presupuesto',
    name: 'Presupuesto Detallado',
    category: 'finanzas',
    description: 'Presupuesto con partidas, cantidades, precio unitario y totales por concepto.',
    tags: ['presupuesto', 'estimado', 'finanzas', 'proyecto'],
    icon: '📈',
    color: '#007AFF',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'PRESUPUESTO', left:40, top:40, fontSize:26, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:500 },
        { type:'i-text', text:'No. PRES-{{nombre}} | {{fecha_hoy}}', left:40, top:76, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:500 },
        { type:'i-text', text:'{{empresa}}', left:500, top:40, fontSize:16, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:280, textAlign:'right' },
        { type:'i-text', text:'{{rfc}} | {{email_empresa}}', left:500, top:62, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:280, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:100, stroke:'#007AFF', strokeWidth:2 },
        { type:'i-text', text:'Preparado para: {{nombre}} | {{email}}', left:40, top:118, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:600 },
        { type:'i-text', text:'Proyecto: {{descripcion}}', left:40, top:140, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:165, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Partida', left:40, top:180, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:280 },
        { type:'i-text', text:'Cant.', left:330, top:180, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:80, textAlign:'center' },
        { type:'i-text', text:'P. Unit.', left:420, top:180, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:120, textAlign:'right' },
        { type:'i-text', text:'Total', left:560, top:180, fontSize:11, fontFamily:'Arial', fontWeight:'bold', fill:'#6C6C70', width:140, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:198, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:215, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:280 },
        { type:'i-text', text:'1', left:330, top:215, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:80, textAlign:'center' },
        { type:'i-text', text:'${{subtotal}}', left:420, top:215, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:120, textAlign:'right' },
        { type:'i-text', text:'${{subtotal}}', left:560, top:215, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:140, textAlign:'right' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:380, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Subtotal:', left:520, top:398, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{subtotal}}', left:640, top:398, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'IVA {{iva_pct_display}}:', left:520, top:418, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:100 },
        { type:'i-text', text:'${{iva}}', left:640, top:418, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:120, textAlign:'right' },
        { type:'i-text', text:'TOTAL:', left:520, top:445, fontSize:15, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:100 },
        { type:'i-text', text:'${{total}} {{moneda}}', left:620, top:445, fontSize:15, fontFamily:'Arial', fontWeight:'bold', fill:'#007AFF', width:140, textAlign:'right' },
      ]
    })
  },

  // ─── OPERACIONES ────────────────────────────────────────────────────────────

  {
    id: 'acta-entrega',
    name: 'Acta de Entrega-Recepción',
    category: 'operaciones',
    description: 'Documento de transferencia de bienes o entregables con inventario y firmas.',
    tags: ['entrega', 'recepción', 'acta', 'inventario'],
    icon: '📦',
    color: '#FF9500',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'ACTA DE ENTREGA-RECEPCIÓN', left:40, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:70, stroke:'#FF9500', strokeWidth:2 },
        { type:'i-text', text:'En {{domicilio}}, siendo las {{hora_actual}} del día {{fecha_hoy}}, se hace constar la entrega de:', left:40, top:88, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'QUIEN ENTREGA:', left:40, top:120, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'{{empresa}} — representada en este acto.', left:40, top:140, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'QUIEN RECIBE:', left:40, top:168, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'{{nombre}} — {{email}} — {{telefono}}', left:40, top:188, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:215, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'BIENES / ENTREGABLES', left:40, top:230, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:400 },
        { type:'i-text', text:'{{descripcion}}', left:40, top:255, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:390, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'OBSERVACIONES:', left:40, top:408, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'Los bienes se reciben en buen estado y conforme a lo pactado.', left:40, top:428, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:500, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'Quien entrega\n{{empresa}}', left:100, top:545, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
        { type:'i-text', text:'Quien recibe\n{{nombre}}', left:480, top:545, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  {
    id: 'carta-oferta',
    name: 'Carta de Oferta Laboral',
    category: 'operaciones',
    description: 'Carta formal de oferta de empleo con puesto, salario, beneficios y fecha de inicio.',
    tags: ['oferta', 'empleo', 'RRHH', 'incorporación'],
    icon: '🤝',
    color: '#34C759',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'{{empresa}}', left:40, top:40, fontSize:18, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:500 },
        { type:'i-text', text:'{{domicilio}}', left:40, top:64, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:500 },
        { type:'i-text', text:'{{fecha_hoy}}', left:40, top:100, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:300 },
        { type:'i-text', text:'{{nombre}}', left:40, top:130, fontSize:13, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:500 },
        { type:'i-text', text:'{{email}}', left:40, top:150, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:400 },
        { type:'i-text', text:'Estimado/a {{nombre}}:', left:40, top:185, fontSize:13, fontFamily:'Arial', fill:'#1A1A2E', width:600 },
        { type:'i-text', text:'Es un placer extenderle una oferta formal de empleo en {{empresa}}.\nNos complace ofrecerle el puesto de {{puesto}} bajo las siguientes condiciones:', left:40, top:210, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'• Puesto: {{puesto}}\n• Salario mensual: ${{total}} {{moneda}}\n• Fecha de inicio: {{fecha_inicio}}\n• Modalidad: {{modalidad}}\n• Beneficios: IMSS, vacaciones, prima vacacional, aguinaldo y plan de crecimiento.', left:40, top:258, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'Esta oferta está condicionada a la presentación de documentos de identidad y la firma\ndel contrato individual de trabajo en la fecha de incorporación.', left:40, top:358, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'Para aceptar esta oferta, comuníquese a más tardar el {{fecha_limite}}.', left:40, top:400, fontSize:12, fontFamily:'Arial', fill:'#34C759', fontWeight:'bold', width:700 },
        { type:'i-text', text:'Atentamente,', left:40, top:440, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:200 },
        { type:'i-text', text:'{{empresa}}', left:40, top:520, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:300 },
        { type:'i-text', text:'Recursos Humanos', left:40, top:538, fontSize:11, fontFamily:'Arial', fill:'#6C6C70', width:300 },
      ]
    })
  },

  {
    id: 'contrato-arrendamiento',
    name: 'Contrato de Arrendamiento',
    category: 'operaciones',
    description: 'Contrato de renta de inmueble con inventario, depósito, renta mensual y cláusulas.',
    tags: ['arrendamiento', 'renta', 'inmueble', 'inquilino'],
    icon: '🏠',
    color: '#5856D6',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'CONTRATO DE ARRENDAMIENTO', left:40, top:40, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:70, stroke:'#5856D6', strokeWidth:2 },
        { type:'i-text', text:'En {{domicilio}}, a {{fecha_hoy}}, entre las partes:', left:40, top:88, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'ARRENDADOR: {{empresa}}, RFC {{rfc}}.', left:40, top:115, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'ARRENDATARIO: {{nombre}}, correo: {{email}}, tel: {{telefono}}.', left:40, top:135, fontSize:12, fontFamily:'Arial', fill:'#1A1A2E', width:700 },
        { type:'i-text', text:'PRIMERA. BIEN ARRENDADO', left:40, top:170, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'El inmueble ubicado en: {{descripcion}}', left:40, top:192, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'SEGUNDA. DESTINO', left:40, top:222, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'El inmueble será destinado exclusivamente para uso habitacional / comercial.', left:40, top:244, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'TERCERA. VIGENCIA', left:40, top:274, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'El arrendamiento tendrá una vigencia de 12 meses a partir del {{fecha_hoy}}.', left:40, top:296, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'CUARTA. RENTA', left:40, top:326, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'Renta mensual: ${{total}} {{moneda}}, pagadera los primeros 5 días de cada mes.\nDepósito en garantía: ${{deposito}} {{moneda}}.', left:40, top:348, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'i-text', text:'QUINTA. SERVICIOS', left:40, top:390, fontSize:12, fontFamily:'Arial', fontWeight:'bold', fill:'#5856D6', width:500 },
        { type:'i-text', text:'Los servicios de luz, agua, gas e internet corren por cuenta del ARRENDATARIO.', left:40, top:412, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:700 },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:480, stroke:'#E5E5EA', strokeWidth:1 },
        { type:'i-text', text:'El Arrendador\n{{empresa}}', left:100, top:530, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
        { type:'i-text', text:'El Arrendatario\n{{nombre}}', left:480, top:530, fontSize:11, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

  {
    id: 'certificado-finalización',
    name: 'Certificado de Finalización',
    category: 'operaciones',
    description: 'Certificado formal de conclusión de proyecto o servicio con descripción y firmas.',
    tags: ['certificado', 'finalización', 'proyecto', 'conclusión'],
    icon: '🏆',
    color: '#FF9500',
    canvas_json: JSON.stringify({
      version: '5.3.1',
      objects: [
        { type:'i-text', text:'{{empresa}}', left:40, top:50, fontSize:20, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:740, y2:0, left:40, top:80, stroke:'#FF9500', strokeWidth:3 },
        { type:'i-text', text:'CERTIFICA QUE:', left:40, top:110, fontSize:14, fontFamily:'Arial', fill:'#6C6C70', width:700, textAlign:'center', fontStyle:'italic' },
        { type:'i-text', text:'{{nombre}}', left:40, top:148, fontSize:24, fontFamily:'Arial', fontWeight:'bold', fill:'#1A1A2E', width:700, textAlign:'center' },
        { type:'i-text', text:'Ha completado satisfactoriamente:', left:40, top:195, fontSize:13, fontFamily:'Arial', fill:'#3C3C43', width:700, textAlign:'center' },
        { type:'i-text', text:'{{descripcion}}', left:40, top:225, fontSize:15, fontFamily:'Arial', fontWeight:'bold', fill:'#FF9500', width:700, textAlign:'center' },
        { type:'line', x1:0, y1:0, x2:400, y2:0, left:180, top:285, stroke:'#FF9500', strokeWidth:1.5 },
        { type:'i-text', text:'Expedido en {{domicilio}}, el {{fecha_hoy}}.', left:40, top:310, fontSize:12, fontFamily:'Arial', fill:'#6C6C70', width:700, textAlign:'center' },
        { type:'i-text', text:'Director General\n{{empresa}}', left:280, top:420, fontSize:12, fontFamily:'Arial', fill:'#3C3C43', width:200, textAlign:'center' },
      ]
    })
  },

];

const CATEGORIES = [
  { id: 'todos',       label: 'Todos',        icon: '✨' },
  { id: 'ventas',      label: 'Ventas',       icon: '💰' },
  { id: 'legal',       label: 'Legal',        icon: '📋' },
  { id: 'finanzas',    label: 'Finanzas',     icon: '🧾' },
  { id: 'operaciones', label: 'Operaciones',  icon: '📦' },
];

// ── Route factory ────────────────────────────────────────────────────────────

module.exports = function makeTemplateLibraryRouter(deps) {
  const { pool, requireAuth, logger } = deps;
  const router = Router();

  // GET /template-library — list all templates (optionally filter by category)
  router.get('/template-library', requireAuth, (req, res) => {
    const { category } = req.query;
    const list = category && category !== 'todos'
      ? LIBRARY.filter(t => t.category === category)
      : LIBRARY;

    // Return metadata only — no canvas_json in list view (save bandwidth)
    res.json({
      categories: CATEGORIES,
      templates: list.map(({ canvas_json: _omit, ...meta }) => meta),
      total: list.length,
    });
  });

  // POST /template-library/:id/import — copy template to user's account
  router.post('/template-library/:id/import', requireAuth, async (req, res) => {
    const tpl = LIBRARY.find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const accountId = req.accountId;
    const safeName  = tpl.name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_') + '.docx';

    try {
      // Build a minimal DOCX from the canvas objects using the docx library
      const docx   = require('docx');
      const canvas = JSON.parse(tpl.canvas_json);
      const objects = (canvas.objects || []).slice().sort((a, b) => (a.top || 0) - (b.top || 0));

      const children = [];
      for (const obj of objects) {
        if (obj.type === 'i-text' || obj.type === 'text') {
          const text  = obj.text || '';
          const lines = text.split('\n');
          for (const line of lines) {
            children.push(new docx.Paragraph({
              children: [new docx.TextRun({
                text: line,
                bold:   obj.fontWeight === 'bold',
                italics: obj.fontStyle === 'italic',
                size:   Math.round((obj.fontSize || 12) * 2),
                color:  (obj.fill || '#000000').replace('#', ''),
                font:   obj.fontFamily || 'Arial',
              })],
              alignment: obj.textAlign === 'center' ? docx.AlignmentType.CENTER
                        : obj.textAlign === 'right'  ? docx.AlignmentType.RIGHT
                        : docx.AlignmentType.LEFT,
            }));
          }
        } else if (obj.type === 'line') {
          children.push(new docx.Paragraph({
            border: { bottom: { color: 'E5E5EA', space: 1, style: docx.BorderStyle.SINGLE, size: 6 } },
          }));
        } else {
          // Skip non-text elements in the initial import DOCX
          // User can open the editor to work with them visually
          children.push(new docx.Paragraph({ children: [] }));
        }
      }

      const doc    = new docx.Document({ sections: [{ children }] });
      const buffer = await docx.Packer.toBuffer(doc);

      await pool.query(
        'INSERT INTO templates (account_id, filename, data, canvas_json) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id, filename) DO UPDATE SET data=$3, canvas_json=$4, updated_at=NOW()',
        [accountId, safeName, buffer, tpl.canvas_json]
      );

      logger.info({ accountId, template: tpl.id, filename: safeName }, 'Library template imported');
      res.json({ success: true, filename: safeName, message: `"${tpl.name}" agregada a tus plantillas` });

    } catch (err) {
      logger.error({ err: err.message, templateId: tpl.id }, 'Library import error');
      res.status(500).json({ error: 'Error al importar plantilla: ' + err.message });
    }
  });

  return router;
};
