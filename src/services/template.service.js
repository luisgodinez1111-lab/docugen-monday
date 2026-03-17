'use strict';

const { pool } = require('./db.service');
const { escapeHtml } = require('../utils/strings');

// Cargar settings globales de la cuenta y mezclar con data
async function injectGlobalSettings(data, accountId) {
  try {
    const r = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [accountId]);
    if (!r.rows.length) return data;
    const s = r.rows[0].settings || {};
    // Campos fiscales
    if (s.empresa) data.empresa = s.empresa;
    if (s.rfc) data.rfc = s.rfc;
    if (s.domicilio) data.domicilio = s.domicilio;
    if (s.iva) data.iva_pct = s.iva;
    if (s.moneda) data.moneda = s.moneda;
    if (s.telefono) data.telefono_empresa = s.telefono;
    if (s.email_empresa) data.email_empresa = s.email_empresa;
    // Formato de fecha
    const locale = s.date_format || 'es-MX';
    const tz = s.timezone || 'America/Mexico_City';
    const now = new Date();
    data.fecha_hoy = now.toLocaleDateString(locale, { timeZone: tz, day:'2-digit', month:'2-digit', year:'numeric' });
    data.fecha_larga = now.toLocaleDateString(locale, { timeZone: tz, day:'numeric', month:'long', year:'numeric' });
    data.hora_actual = now.toLocaleTimeString(locale, { timeZone: tz, hour:'2-digit', minute:'2-digit' });
    // Campos personalizados
    if (s.custom_fields && Array.isArray(s.custom_fields)) {
      s.custom_fields.forEach(f => { if (f.key && f.value) data[f.key] = f.value; });
    }
  } catch(e) { (console).debug('Settings inject error:', e.message); }
  return data;
}

async function createDocxtemplater(zip, accountId) {
  const Docxtemplater = require('docxtemplater');

  let logoBuffer = null;
  try {
    const logoResult = await pool.query('SELECT data FROM logos WHERE account_id = $1', [accountId]);
    if (logoResult.rows.length) {
      logoBuffer = logoResult.rows[0].data;
    }
  } catch(e) {}

  // Inyectar logo directamente en el XML del docx
  if (logoBuffer) {
    const logoBase64 = logoBuffer.toString('base64');
    const logoExt = 'jpeg';
    const rId = 'rId100';

    // Agregar imagen a los archivos del zip
    zip.file('word/media/logo.' + logoExt, logoBuffer);

    // Agregar relacion en document.xml.rels
    let rels = zip.files['word/_rels/document.xml.rels'].asText();
    if (!rels.includes(rId)) {
      rels = rels.replace('</Relationships>',
        '<Relationship Id="' + rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.' + logoExt + '"/></Relationships>'
      );
      zip.file('word/_rels/document.xml.rels', rels);
    }

    // Reemplazar {{logo}} en document.xml con imagen inline
    let docXml = zip.files['word/document.xml'].asText();
    const imgXml = '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1714500" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="100" name="logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="100" name="logo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rId + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1714500" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';

    // Reemplazar el parrafo completo que contiene {%logo}
    // Primero normalizar el XML eliminando runs partidos alrededor del tag logo
    // Luego reemplazar el parrafo completo
    const logoParaRegex = /<w:p[ >][sS]*?(?:<w:t[^>]*>[^<]*\{%logo\}[^<]*<\/w:t>|\{%logo\})[sS]*?<\/w:p>/g;
    const paraMatch = docXml.match(logoParaRegex);
    if (paraMatch) {
      docXml = docXml.replace(logoParaRegex, '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r>' + imgXml + '<\/w:r><\/w:p>');
    } else {
      // Buscar cualquier parrafo que tenga %logo en su contenido de texto
      docXml = docXml.replace(/<w:p[ >][^§]*?<w:t[^>]*>[^<]*%logo[^<]*<\/w:t>[^§]*?<\/w:p>/g,
        '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r>' + imgXml + '<\/w:r><\/w:p>');
    }
    zip.file('word/document.xml', docXml);
  }

  return new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' }
  });
}

module.exports = { injectGlobalSettings, createDocxtemplater };
