'use strict';

const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _loConvert = null;
try {
  _loConvert = promisify(require('libreoffice-convert').convert);
} catch {
  // libreoffice-convert not found — falling back to execFile
}

const outputsDir = path.join(__dirname, '..', '..', 'outputs');

/**
 * Convert a DOCX Buffer → PDF Buffer using libreoffice-convert.
 * Falls back to execFile('libreoffice') when the library is unavailable.
 * @param {Buffer} docxBuffer
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<Buffer>}
 */
async function convertDocxToPdf(docxBuffer, timeoutMs = 60000) {
  if (_loConvert) {
    const timeoutP = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`libreoffice-convert timed out (${timeoutMs}ms)`)), timeoutMs)
    );
    return Promise.race([_loConvert(docxBuffer, '.pdf', undefined), timeoutP]);
  }
  // Fallback: write tmp file, execFile, read back
  const { execFile } = require('child_process');
  if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
  const tmpDocx = path.join(outputsDir, `tmp_${crypto.randomBytes(8).toString('hex')}.docx`);
  fs.writeFileSync(tmpDocx, docxBuffer);
  return new Promise((resolve, reject) => {
    execFile('libreoffice', ['--headless', '--convert-to', 'pdf', '--outdir', outputsDir, tmpDocx],
      { timeout: timeoutMs },
      (err) => {
        try { fs.unlinkSync(tmpDocx); } catch(_) {}
        const pdfPath = tmpDocx.replace('.docx', '.pdf');
        if (err || !fs.existsSync(pdfPath)) return reject(err || new Error('PDF not created'));
        resolve(fs.readFileSync(pdfPath));
        try { fs.unlinkSync(pdfPath); } catch(_) {}
      });
  });
}

function toVarName(title) {
  return title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function extractColumnValue(col) {
  if (col.column && (col.column.type === 'mirror' || col.column.type === 'board_relation')) {
    return col.display_value || col.text || '';
  }
  if (col.column && col.column.type === 'location') {
    if (col.text) return col.text;
    try { const val = JSON.parse(col.value || '{}'); return val.address || ''; } catch(e) { return ''; }
  }
  return col.text || col.display_value || '';
}

function numeroALetras(num) {
  const unidades = ['','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince','dieciseis','diecisiete','dieciocho','diecinueve'];
  const decenas = ['','diez','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
  const centenas = ['','cien','doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos'];
  if (num === 0) return 'CERO 00/100 M.N.';
  const entero = Math.floor(num);
  const decimales = Math.round((num - entero) * 100);
  function convertir(n) {
    if (n < 20) return unidades[n];
    if (n < 100) return decenas[Math.floor(n/10)] + (n%10 ? ' Y ' + unidades[n%10] : '');
    if (n < 1000) return centenas[Math.floor(n/100)] + (n%100 ? ' ' + convertir(n%100) : '');
    if (n < 1000000) return convertir(Math.floor(n/1000)) + ' MIL' + (n%1000 ? ' ' + convertir(n%1000) : '');
    return convertir(Math.floor(n/1000000)) + ' MILLONES' + (n%1000000 ? ' ' + convertir(n%1000000) : '');
  }
  const letras = convertir(entero).toUpperCase();
  return letras + ' ' + (decimales > 0 ? decimales + '/100 M.N.' : '00/100 M.N.');
}

function calcularTotales(data, subitems, columnValues, ivaRate = 0.16) {
  // Calcular desde subitems
  if (subitems && subitems.length > 0) {
    let subtotalGeneral = 0;
    data.subelementos = subitems.map((sub, index) => {
      const subData = { nombre: sub.name, numero: String(index + 1) };
      let cantidad = null;
      let precio = null;
      sub.column_values.forEach(col => {
        const k = toVarName(col.column.title);
        const val = extractColumnValue(col);
        subData[k] = val;
        if (col.column.type === 'numbers') {
          const num = parseFloat(val) || 0;
          if (k.includes('cantidad') || k.includes('qty')) { cantidad = num; }
          else if (k.includes('precio') || k.includes('price') || k.includes('costo') || k.includes('unit')) { precio = num; }
          else if (cantidad === null) { cantidad = num; }
          else if (precio === null) { precio = num; }
        }
      });
      // Formatear precio
        if (precio !== null) {
          subData.precio_fmt = precio.toLocaleString('es-MX', { minimumFractionDigits: 2 });
        }
        if (cantidad !== null && precio !== null) {
        const st = cantidad * precio;
        subData.subtotal_linea = st.toFixed(2);
        subData.subtotal_linea_fmt = st.toLocaleString('es-MX', { minimumFractionDigits: 2 });
        subtotalGeneral += st;
      }
      return subData;
    });
    const iva = subtotalGeneral * ivaRate;
    const total = subtotalGeneral + iva;
    data.subtotal = subtotalGeneral.toFixed(2);
    data.subtotal_fmt = subtotalGeneral.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.iva = iva.toFixed(2);
    data.iva_fmt = iva.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.total = total.toFixed(2);
    data.total_fmt = total.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.total_letras = numeroALetras(total);
    data.iva_rate = ivaRate;
    data.iva_pct_display = (ivaRate * 100).toFixed(0) + '%';
    data.tiene_iva = iva > 0;
    data.tiene_subelementos = (data.subelementos || []).length > 0;
    data.es_grande = total > 100000;
    data.es_aprobado = (data.status || '').toLowerCase().includes('approv') || (data.status || '').toLowerCase().includes('aprobad');
    data.es_pendiente = !data.es_aprobado;
  } else {
    // Calcular desde columnas numéricas del item principal
    const montoCol = columnValues.find(col => {
      const k = toVarName(col.column.title);
      return col.column.type === 'numbers' && (k.includes('monto') || k.includes('total') || k.includes('precio') || k.includes('importe'));
    });
    if (montoCol) {
      const monto = parseFloat(extractColumnValue(montoCol)) || 0;
      const iva = monto * ivaRate;
      const total = monto + iva;
      data.iva = iva.toFixed(2);
      data.iva_fmt = iva.toLocaleString('es-MX', { minimumFractionDigits: 2 });
      data.total_con_iva = total.toFixed(2);
      data.total_con_iva_fmt = total.toLocaleString('es-MX', { minimumFractionDigits: 2 });
      data.total_letras = numeroALetras(total);
      data.iva_rate = ivaRate;
      data.iva_pct_display = (ivaRate * 100).toFixed(0) + '%';
      data.tiene_iva = iva > 0;
      data.tiene_subelementos = (data.subelementos || []).length > 0;
      data.es_grande = total > 100000;
      data.es_aprobado = (data.status || '').toLowerCase().includes('approv') || (data.status || '').toLowerCase().includes('aprobad');
      data.es_pendiente = !data.es_aprobado;
    }
  }
}

const GRAPHQL_COLUMN_FRAGMENT = `
  id text value
  column { title type }
  ... on MirrorValue { display_value }
  ... on BoardRelationValue { display_value }
  ... on FormulaValue { display_value }
`;

module.exports = {
  GRAPHQL_COLUMN_FRAGMENT,
  convertDocxToPdf,
  toVarName,
  extractColumnValue,
  numeroALetras,
  calcularTotales,
};
