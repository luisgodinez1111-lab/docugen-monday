const express = require('express');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const cron = require('node-cron');

const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const ImageModule = require('docxtemplater-image-module-free');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tokens (account_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, user_id TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS templates (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL, filename TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(account_id, filename));`);
    await pool.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS canvas_json TEXT`);
    await pool.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await pool.query(`CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL, board_id TEXT, item_id TEXT, item_name TEXT, template_name TEXT, filename TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_data BYTEA');
    await pool.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_pdf BYTEA');
    await pool.query(`CREATE TABLE IF NOT EXISTS pdf_jobs (
        job_id TEXT PRIMARY KEY,
        account_id TEXT,
        status TEXT DEFAULT 'processing',
        filename TEXT,
        item_name TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS logos (
      account_id TEXT PRIMARY KEY,
      filename TEXT,
      data BYTEA NOT NULL,
      mimetype TEXT DEFAULT 'image/png',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query('ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS pdf_data BYTEA');
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      plan TEXT DEFAULT 'free',
      docs_generated INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT,
      item_id TEXT,
      board_id TEXT,
      column_id TEXT,
      column_value TEXT,
      account_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_triggers (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      board_id TEXT,
      column_id TEXT,
      trigger_value TEXT,
      template_name TEXT,
      action TEXT DEFAULT 'generate',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_automations (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      name TEXT,
      cron_expression TEXT,
      board_id TEXT,
      template_name TEXT,
      condition_column TEXT,
      condition_value TEXT,
      last_run TIMESTAMP,
      next_run TIMESTAMP,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS signature_requests (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      item_id TEXT,
      board_id TEXT,
      document_filename TEXT,
      signer_name TEXT,
      signer_email TEXT,
      token TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      signed_at TIMESTAMP,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_pdf BYTEA');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_type TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_order INT DEFAULT 1');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS group_id TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_code TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN DEFAULT FALSE');
    console.log('Base de datos inicializada');
  } catch (err) {
    console.error('Error iniciando DB:', err.message);
  }
}

const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir);

const upload = multer({ storage: multer.memoryStorage() });

async function saveToken(accountId, userId, token) {
  await pool.query(`INSERT INTO tokens (account_id, user_id, access_token, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (account_id) DO UPDATE SET access_token = $3, user_id = $2, updated_at = NOW()`, [accountId, userId, token]);
}

async function getToken(accountId) {
  const res = await pool.query('SELECT access_token FROM tokens WHERE account_id = $1', [accountId]);
  return res.rows[0]?.access_token || null;
}

async function requireAuth(req, res, next) {
  const accountId = req.headers['x-account-id'] || req.query.account_id || req.body?.account_id;
  if (!accountId) return res.status(401).json({ error: 'Se requiere account_id' });
  const token = await getToken(accountId);
  if (!token) return res.status(401).json({ error: 'No hay sesion. Haz OAuth primero.', needs_auth: true });
  req.accountId = accountId;
  req.accessToken = token;
  next();
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

function toVarName(title) {
  return title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
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

async function createDocxtemplater(zip, accountId) {
  let logoBuffer = null;
  try {
    const logoResult = await pool.query('SELECT data FROM logos WHERE account_id = $1', [accountId]);
    if (logoResult.rows.length) {
      logoBuffer = logoResult.rows[0].data;
      console.log('Logo encontrado:', logoBuffer.length, 'bytes');
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
    console.log('Logo inyectado en XML');
  }

  return new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' }
  });
}


function calcularTotales(data, subitems, columnValues) {
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
    const iva = subtotalGeneral * 0.16;
    const total = subtotalGeneral + iva;
    data.subtotal = subtotalGeneral.toFixed(2);
    data.subtotal_fmt = subtotalGeneral.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.iva = iva.toFixed(2);
    data.iva_fmt = iva.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.total = total.toFixed(2);
    data.total_fmt = total.toLocaleString('es-MX', { minimumFractionDigits: 2 });
    data.total_letras = numeroALetras(total);
  data.tiene_iva = parseFloat(data.iva || 0) > 0;
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
      const iva = monto * 0.16;
      const total = monto + iva;
      data.iva = iva.toFixed(2);
      data.iva_fmt = iva.toLocaleString('es-MX', { minimumFractionDigits: 2 });
      data.total_con_iva = total.toFixed(2);
      data.total_con_iva_fmt = total.toLocaleString('es-MX', { minimumFractionDigits: 2 });
      data.total_letras = numeroALetras(total);
  data.tiene_iva = parseFloat(data.iva || 0) > 0;
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

app.get('/debug-docs', async (req, res) => {
  try {
    const accountId = req.query.account_id || req.headers['x-account-id'];
    const r = await pool.query(
      'SELECT id, filename, template_name, item_id, created_at, doc_data IS NOT NULL as has_data, length(doc_data) as data_size FROM documents WHERE account_id=$1 ORDER BY created_at DESC LIMIT 15',
      [accountId]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => { res.json({ status: 'ok', message: 'DocuGen for monday', version: '3.0.0' }); });

app.get('/oauth/start', (req, res) => {
  const clientId = process.env.MONDAY_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
  res.redirect('https://auth.monday.com/oauth2/authorize?client_id=' + clientId + '&redirect_uri=' + redirectUri);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No se recibio codigo' });
  try {
    const response = await axios.post('https://auth.monday.com/oauth2/token', {
      client_id: process.env.MONDAY_CLIENT_ID,
      client_secret: process.env.MONDAY_CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI
    });
    const { access_token } = response.data;
    const decoded = jwt.decode(access_token);
    const accountId = decoded?.actid?.toString() || 'default';
    const userId = decoded?.uid?.toString() || null;
    await saveToken(accountId, userId, access_token);
    console.log('Token guardado — account: ' + accountId);
    res.redirect('/view?account_id=' + accountId);
  } catch (error) {
    console.error('Error OAuth:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
  }
});

app.get('/auth/check', async (req, res) => {
  const accountId = req.query.account_id;
  if (!accountId) return res.json({ authenticated: false });
  const token = await getToken(accountId);
  res.json({ authenticated: !!token, account_id: accountId });
});

app.post('/board-items', requireAuth, async (req, res) => {
  const { board_id } = req.body;
  try {
    const query = 'query { boards(ids: ' + board_id + ') { name columns { id title type } items_page(limit: 50) { items { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } } } }';
    const response = await axios.post('https://api.monday.com/v2', { query }, { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } });
    res.json(response.data);
  } catch (error) {
    console.error('GraphQL error:', JSON.stringify(error.response?.data || error.message));
    res.status(500).json({ error: 'Error GraphQL', details: error.response?.data, message: error.message });
  }
});

app.post('/item-variables', requireAuth, async (req, res) => {
  const { item_id } = req.body;
  try {
    const query = 'query { items(ids: ' + item_id + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
    const response = await axios.post('https://api.monday.com/v2', { query }, { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } });
    console.log('GraphQL response errors:', JSON.stringify(response.data.errors));
    console.log('Items encontrados:', response.data.data?.items?.length);
    const item = response.data.data.items[0];
    const variables = [{ variable: 'nombre', value: item.name, type: 'name' }];
    item.column_values.forEach(col => {
      variables.push({ variable: toVarName(col.column.title), original_title: col.column.title, value: extractColumnValue(col) || '(vacio)', type: col.column.type });
    });
    if (item.subitems?.length) {
      variables.push({ variable: 'subelementos', value: 'Lista de ' + item.subitems.length + ' subelementos', type: 'subitems', note: 'Usar {{#subelementos}}...{{/subelementos}}' });
      variables.push({ variable: 'subtotal', value: 'Calculado automaticamente', type: 'formula' });
      variables.push({ variable: 'iva', value: 'Calculado automaticamente (16%)', type: 'formula' });
      variables.push({ variable: 'total', value: 'Calculado automaticamente', type: 'formula' });
      variables.push({ variable: 'total_letras', value: 'Total en letras', type: 'formula' });
    }
    const montoCol = item.column_values.find(col => { const k = toVarName(col.column.title); return col.column.type === 'numbers' && (k.includes('monto') || k.includes('total') || k.includes('precio')); });
    if (montoCol && !item.subitems?.length) {
      variables.push({ variable: 'iva', value: 'Calculado automaticamente (16%)', type: 'formula' });
      variables.push({ variable: 'total_con_iva', value: 'Calculado automaticamente', type: 'formula' });
      variables.push({ variable: 'total_letras', value: 'Total en letras', type: 'formula' });
    }
    res.json({ variables, item_name: item.name });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener variables', details: error.message });
  }
});

app.post('/templates/upload', upload.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio archivo' });
  const accountId = req.body.account_id || 'default';
  try {
    await pool.query(`INSERT INTO templates (account_id, filename, data) VALUES ($1, $2, $3) ON CONFLICT (account_id, filename) DO UPDATE SET data = $3`, [accountId, req.file.originalname, req.file.buffer]);
    res.json({ success: true, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar plantilla', details: err.message });
  }
});

app.get('/templates', async (req, res) => {
  const accountId = req.query.account_id || 'default';
  try {
    const result = await pool.query('SELECT filename, created_at, updated_at, (canvas_json IS NOT NULL) as has_editor FROM templates WHERE account_id = $1 ORDER BY COALESCE(updated_at, created_at) DESC', [accountId]);
    res.json({ templates: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar plantillas' });
  }
});


// Subir logo de cuenta
app.post('/logo/upload', upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const accountId = req.body.account_id || 'default';
  try {
    await pool.query(
      'INSERT INTO logos (account_id, filename, data, mimetype) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET data=$3, filename=$2, mimetype=$4',
      [accountId, req.file.originalname, req.file.buffer, req.file.mimetype]
    );
    res.json({ success: true, filename: req.file.originalname });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener logo de cuenta
app.get('/logo', async (req, res) => {
  const accountId = req.query.account_id || 'default';
  try {
    const result = await pool.query('SELECT data, mimetype, filename FROM logos WHERE account_id = $1', [accountId]);
    if (!result.rows.length) return res.status(404).json({ error: 'No hay logo' });
    res.set('Content-Type', result.rows[0].mimetype);
    res.send(result.rows[0].data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/generate-from-monday', requireAuth, async (req, res) => {
  const { board_id, item_id, template_name } = req.body;
  try {
    const tplResult = await pool.query('SELECT data FROM templates WHERE account_id = $1 AND filename = $2', [req.accountId, template_name]);
    if (!tplResult.rows.length) return res.status(404).json({ error: 'Plantilla "' + template_name + '" no encontrada' });

    const query = 'query { items(ids: ' + item_id + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
    const response = await axios.post('https://api.monday.com/v2', { query }, { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } });
    const item = response.data.data.items[0];
    console.log('Item obtenido:', item?.name);

    const data = { nombre: item.name };
    item.column_values.forEach(col => {
      data[toVarName(col.column.title)] = extractColumnValue(col);
    });

    calcularTotales(data, item.subitems, item.column_values);

    console.log('Variables para plantilla:', JSON.stringify(data, null, 2));

    const zip = new PizZip(tplResult.rows[0].data);
    const doc = await createDocxtemplater(zip, req.accountId);
    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.docx';
    fs.writeFileSync(path.join(outputsDir, outputFilename), outputBuffer);

    await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.accountId, board_id, item_id, item.name, template_name, outputFilename, outputBuffer]);

    res.json({ success: true, filename: outputFilename, data_used: data, download_url: '/download/' + outputFilename });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al generar', details: error.message });
  }
});

app.get('/documents', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, item_name, template_name, filename, created_at FROM documents WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20', [req.accountId]);
    res.json({ documents: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});


// Generar documento desde monday en formato PDF o DOCX
app.post('/generate-from-monday-pdf', requireAuth, async (req, res) => {
  const { board_id, item_id, template_name } = req.body;
  const { exec } = require('child_process');

  try {
    const tplResult = await pool.query(
      'SELECT data FROM templates WHERE account_id = $1 AND filename = $2',
      [req.accountId, template_name]
    );
    if (!tplResult.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const query = 'query { items(ids: ' + item_id + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
    const response = await axios.post('https://api.monday.com/v2', { query }, { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } });
    const item = response.data.data.items[0];

    const data = { nombre: item.name };
    item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
    calcularTotales(data, item.subitems, item.column_values);

    const zip = new PizZip(tplResult.rows[0].data);
    const doc = await createDocxtemplater(zip, req.accountId);
    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const baseName = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now();
    const docxPath = path.join(outputsDir, baseName + '.docx');
    const pdfPath = path.join(outputsDir, baseName + '.pdf');
    fs.writeFileSync(docxPath, outputBuffer);

    // Convertir a PDF con LibreOffice
    console.log('Renderizando plantilla...');

    exec('libreoffice --headless --convert-to pdf --outdir ' + outputsDir + ' ' + docxPath, async (err) => {
      console.log('LibreOffice terminó, err:', err?.message, 'pdf existe:', fs.existsSync(pdfPath));
      // Limpiar docx temporal
      try { fs.unlinkSync(docxPath); } catch(e) {}
      
      if (err || !fs.existsSync(pdfPath)) {
        return res.status(500).json({ error: 'Error convirtiendo a PDF', details: err?.message });
      }

      const pdfData = fs.readFileSync(pdfPath);
      await pool.query(
        'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]
      );

      res.download(pdfPath, baseName + '.pdf', () => {
        try { fs.unlinkSync(pdfPath); } catch(e) {}
      });
    });
  } catch (error) {
    console.error('Error PDF:', error);
    res.status(500).json({ error: 'Error al generar PDF', details: error.message });
  }
});


// Jobs PDF en PostgreSQL
console.log('PDF async endpoint registrado');

app.post('/generate-pdf-async', requireAuth, async (req, res) => {
  const { exec } = require('child_process');
  const { board_id, item_id, template_name } = req.body;
  const jobId = Date.now().toString();
  const accountId = req.accountId;
  const accessToken = req.accessToken;

  console.log('PDF async - inicio, job:', jobId, 'token:', accessToken ? 'ok' : 'missing');

  try {
    await pool.query('INSERT INTO pdf_jobs (job_id, account_id, status) VALUES ($1,$2,$3)', [jobId, accountId, 'processing']);
    res.json({ job_id: jobId, status: 'processing' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }

  // Usar setImmediate para ejecutar fuera del ciclo del request
  setImmediate(async () => {
    try {
      console.log('PDF async - obteniendo plantilla...');
      const tplResult = await pool.query('SELECT data FROM templates WHERE account_id = $1 AND filename = $2', [accountId, template_name]);
      if (!tplResult.rows.length) {
        await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', 'Plantilla no encontrada', jobId]);
        return;
      }

      console.log('PDF async - consultando monday...');
      const query = 'query { items(ids: ' + item_id + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
      
      const response = await axios.post('https://api.monday.com/v2', { query }, {
        headers: { Authorization: accessToken, 'Content-Type': 'application/json' },
        timeout: 20000
      });

      const item = response.data.data?.items?.[0];
      if (!item) {
        await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', 'Item no encontrado', jobId]);
        return;
      }
      console.log('PDF async - item obtenido:', item.name);

      const data = { nombre: item.name };
      item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
      calcularTotales(data, item.subitems, item.column_values);

      const zip = new PizZip(tplResult.rows[0].data);
      const doc = await createDocxtemplater(zip, accountId);
      doc.render(data);

      const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
      const baseName = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now();
      const docxPath = path.join(outputsDir, baseName + '.docx');
      const pdfPath = path.join(outputsDir, baseName + '.pdf');
      fs.writeFileSync(docxPath, outputBuffer);

      console.log('PDF async - convirtiendo con LibreOffice...');
      exec('libreoffice --headless --convert-to pdf --outdir ' + outputsDir + ' ' + docxPath, async (err) => {
        try { fs.unlinkSync(docxPath); } catch(e) {}
        if (err || !fs.existsSync(pdfPath)) {
          console.error('PDF async - error LibreOffice:', err?.message);
          await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', 'Error convirtiendo a PDF: ' + (err?.message || 'unknown'), jobId]);
          return;
        }
        console.log('PDF async - PDF listo:', pdfPath);
        const pdfData = fs.readFileSync(pdfPath);
        await pool.query('UPDATE pdf_jobs SET status=$1, filename=$2, item_name=$3, pdf_data=$4 WHERE job_id=$5', ['ready', baseName + '.pdf', item.name, pdfData, jobId]);
        await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]);
      });

    } catch(err) {
      console.error('PDF async - error:', err.message);
      await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', err.message, jobId]).catch(()=>{});
    }
  });

});


app.get('/pdf-status/:jobId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pdf_jobs WHERE job_id = $1', [req.params.jobId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Job no encontrado' });
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/download-pdf/:filename', async (req, res) => {
  const filename = req.params.filename;
  const accountId = req.headers['x-account-id'] || req.query.account_id;
  if (!accountId) return res.status(400).json({ error: 'Se requiere account_id' });
  try {
    const result = await pool.query('SELECT pdf_data FROM pdf_jobs WHERE filename=$1 AND account_id=$2', [filename, accountId]);
    if (result.rows.length && result.rows[0].pdf_data) {
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(result.rows[0].pdf_data);
    }
    // Fallback filesystem
    const pdfPath = path.join(outputsDir, filename);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF no encontrado' });
    res.download(pdfPath, filename);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(outputsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(filePath);
});

app.post('/migrate', async (req, res) => {
  if (req.body.secret !== 'docugen2026') return res.status(403).json({ error: 'No autorizado' });
  try {
    await pool.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT');
    res.json({ success: true, message: 'Migracion completada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/view', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'view.html')); });
app.get('/editor', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'editor.html')); });
app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });

app.listen(PORT, async () => {
  console.log('DocuGen servidor corriendo en puerto ' + PORT);
  console.log('App ID: ' + process.env.MONDAY_APP_ID);
  console.log('Ambiente: ' + (process.env.NODE_ENV || 'development'));
  await initDB();
});

module.exports = app;

// ============================================================
// EDITOR: Canvas JSON → DOCX
// ============================================================
app.post('/editor/save-template', requireAuth, async (req, res) => {
  const { canvasJson, templateName } = req.body;
  if (!canvasJson || !templateName) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
            AlignmentType, WidthType, BorderStyle, ShadingType, HeadingLevel,
            UnderlineType } = require('docx');

    const objects = canvasJson.objects || [];
    const expandHex = c => { if(!c||typeof c!=='string') return '000000'; const h = c.replace('#',''); return h.length === 3 ? h.split('').map(x=>x+x).join('') : h.padEnd(6,'0'); };
    const PAGE_W_PT = 9360; // ~6.5 inches in twips (1/20 pt)
    const PAGE_H = 1123;
    const PAGE_W_PX = 794;

    // Sort by top position
    objects.sort((a, b) => (a.top || 0) - (b.top || 0));

    const children = [];

    for (const obj of objects) {
      if (obj.isGrid) continue;

      if (obj.type === 'i-text' || obj.type === 'text') {
        const text = obj.text || '';
        const fontSize = Math.round((obj.fontSize || 12) * 1.1);
        const align = obj.textAlign === 'center' ? AlignmentType.CENTER
                    : obj.textAlign === 'right' ? AlignmentType.RIGHT
                    : AlignmentType.LEFT;

        children.push(new Paragraph({
          alignment: align,
          spacing: { before: 40, after: 40 },
          children: [new TextRun({
            text,
            size: fontSize * 2,
            bold: obj.fontWeight === 'bold',
            italics: obj.fontStyle === 'italic',
            underline: obj.underline ? { type: UnderlineType.SINGLE } : undefined,
            color: expandHex(obj.fill || '#000000'),
            font: obj.fontFamily || 'Arial',
          })]
        }));

      } else if (obj.type === 'rect') {
        // Colored block as table cell
        const fillColor = (obj.fill || '#ffffff').replace('#', '');
        const strokeColor = (obj.stroke || '#000000').replace('#', '');
        const widthPct = Math.round((obj.width * (obj.scaleX || 1) / PAGE_W_PX) * 100 * 50);
        children.push(new Table({
          width: { size: widthPct, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: [
            new TableCell({
              shading: { fill: fillColor, type: ShadingType.CLEAR },
              borders: {
                top: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                bottom: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                left: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                right: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
              },
              children: [new Paragraph({ children: [] })]
            })
          ]})]
        }));
        children.push(new Paragraph({ children: [] }));

      } else if (obj.type === 'line') {
        const strokeColor = (obj.stroke || '#000000').replace('#', '');
        children.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 1) * 8), color: strokeColor, space: 1 } },
          children: []
        }));

      } else if (obj.type === 'image') {
        // Image stored as base64 in src
        if (obj.src && obj.src.startsWith('data:')) {
          const matches = obj.src.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            const mimeType = matches[1];
            const imgData = Buffer.from(matches[2], 'base64');
            const imgW = Math.round(obj.width * (obj.scaleX || 1));
            const imgH = Math.round(obj.height * (obj.scaleY || 1));
            // Convert px to EMU (1px = 9525 EMU)
            children.push(new Paragraph({
              children: [new ImageRun({
                data: imgData,
                transformation: { width: imgW, height: imgH },
                type: mimeType.includes('png') ? 'png' : 'jpg',
              })]
            }));
          }
        }

      } else if (obj.type === 'group') {
        if (obj.tableType === 'products' && obj.tableCols) {
          // Real table with loop
          const cols = obj.tableCols;
          const expandHex = c => { const h = c.replace('#',''); return h.length === 3 ? h.split('').map(x=>x+x).join('') : h; };
        const headerColor = expandHex(obj.tableHeaderColor || '#2D5BE3');
          const loopName = obj.tableLoop || 'subelementos';
          const colWidthPct = Math.floor(100 / cols.length);

          // Header row
          const headerCells = cols.map(col => new TableCell({
            shading: { fill: headerColor, type: ShadingType.CLEAR },
            borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
            width: { size: colWidthPct, type: WidthType.PERCENTAGE },
            children: [new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: col.header, bold: true, color: 'FFFFFF', size: 20, font: 'Arial' })]
            })]
          }));

          // Data row with loop variables
          const dataCells = cols.map((col, i) => {
            const isFirst = i === 0;
            const isLast = i === cols.length - 1;
            const cellText = (isFirst ? '{#' + loopName + '}' : '') + col.variable + (isLast ? '{/' + loopName + '}' : '');
            return new TableCell({
              shading: { fill: 'F8F9FF', type: ShadingType.CLEAR },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                left: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                right: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
              },
              width: { size: colWidthPct, type: WidthType.PERCENTAGE },
              children: [new Paragraph({
                children: [new TextRun({ text: cellText, size: 20, font: 'Arial' })]
              })]
            });
          });

          const table = new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ children: headerCells }),
              new TableRow({ children: dataCells })
            ]
          });
          children.push(table);
          children.push(new Paragraph({ children: [] }));

        } else if (obj.objects) {
          // Other groups - extract text
          const texts = obj.objects
            .filter(o => o.type === 'text' || o.type === 'i-text')
            .map(o => o.text || '')
            .join(' ');
          if (texts) {
            children.push(new Paragraph({
              children: [new TextRun({ text: texts, size: 22, font: 'Arial' })]
            }));
          }
        }
      }
    }

    if (!children.length) children.push(new Paragraph({ children: [] }));

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1080, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        children
      }]
    });

    const buffer = await Packer.toBuffer(doc);

    // Save to DB as template
    const filename = templateName.replace(/[^a-zA-Z0-9\-_]/g, '_') + '.docx';
    await pool.query(
      'INSERT INTO templates (account_id, filename, data, canvas_json, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (account_id, filename) DO UPDATE SET data=$3, canvas_json=$4, updated_at=NOW()',
      [req.accountId, filename, buffer, JSON.stringify(canvasJson)]
    );

    res.json({ success: true, filename });
  } catch(err) {
    console.error('Editor save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TEMPLATE MANAGEMENT ──────────────────────────────────
app.get('/templates/:filename/canvas', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT canvas_json FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json({ canvas_json: r.rows[0].canvas_json ? JSON.parse(r.rows[0].canvas_json) : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/templates/:filename', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/templates/:filename/duplicate', requireAuth, async (req, res) => {
  try {
    const { newName } = req.body;
    const r = await pool.query('SELECT data, canvas_json FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
    const newFilename = (newName || req.params.filename.replace('.docx','') + '_copia') + '.docx';
    await pool.query(
      'INSERT INTO templates (account_id, filename, data, canvas_json) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id, filename) DO UPDATE SET data=$3, canvas_json=$4',
      [req.accountId, newFilename, r.rows[0].data, r.rows[0].canvas_json]
    );
    res.json({ success: true, filename: newFilename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/templates/:filename/rename', requireAuth, async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'Nuevo nombre requerido' });
    const newFilename = newName.endsWith('.docx') ? newName : newName + '.docx';
    await pool.query('UPDATE templates SET filename=$1, updated_at=NOW() WHERE account_id=$2 AND filename=$3', [newFilename, req.accountId, req.params.filename]);
    res.json({ success: true, filename: newFilename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── FIRMA DIGITAL ────────────────────────────────────────
app.post('/signatures/request', requireAuth, async (req, res) => {
  const { document_filename, signer_name, signer_email, item_id, board_id } = req.body;
  if (!document_filename || !signer_name) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días
    await pool.query(`CREATE TABLE IF NOT EXISTS signature_requests (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      account_id TEXT NOT NULL,
      document_filename TEXT NOT NULL,
      signer_name TEXT,
      signer_email TEXT,
      item_id TEXT,
      board_id TEXT,
      status TEXT DEFAULT 'pending',
      signature_data TEXT,
      signed_at TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_ip TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS user_agent TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_pdf BYTEA');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_type TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_order INT DEFAULT 1');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS group_id TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_code TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN DEFAULT FALSE');
    await pool.query(
      'INSERT INTO signature_requests (token, account_id, document_filename, signer_name, signer_email, item_id, board_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [token, req.accountId, document_filename, signer_name, signer_email, item_id, board_id, expiresAt]
    );
    const signUrl = process.env.APP_URL + '/sign/' + token;

    // Enviar email al firmante si hay email
    if (signer_email) {
      try {
        await resend.emails.send({
          from: 'DocuGen <onboarding@resend.dev>',
          to: signer_email,
          subject: 'Documento pendiente de tu firma — ' + document_filename,
          html: emailSignRequest(signer_name, document_filename, signUrl, expiresAt)
        });
      } catch(emailErr) { console.error('Email error:', emailErr.message); }
    }

    res.json({ success: true, token, sign_url: signUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PDF on-demand para portal viewer
app.get('/sign/:token/preview-pdf', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).send('No encontrado');
    const sig = r.rows[0];
    const filename = sig.document_filename;
    const pdfFilename = filename.replace(/\.docx$/i, '.pdf');

    // 1. Buscar PDF generado por item_id (el real, no la plantilla)
    let pdfData = null;
    if (sig.item_id) {
      const pdfR = await pool.query(
        "SELECT doc_data FROM documents WHERE item_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [String(sig.item_id)]
      );
      if (pdfR.rows.length) pdfData = pdfR.rows[0].doc_data;
    }
    if (pdfData) {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="documento.pdf"');
      return res.send(pdfData);
    }

    // 2. Buscar DOCX generado por item_id (no la plantilla)
    const docR = { rows: [] };
    if (sig.item_id) {
      const docR2 = await pool.query(
        "SELECT doc_data, filename FROM documents WHERE item_id=$1 AND doc_data IS NOT NULL AND filename != $2 AND filename NOT LIKE '%.pdf' ORDER BY created_at DESC LIMIT 1",
        [String(sig.item_id), filename]
      );
      if (docR2.rows.length) docR.rows.push(docR2.rows[0]);
    }
    if (!docR.rows.length && sig.account_id) {
      const docR3 = await pool.query(
        "SELECT doc_data, filename FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL AND filename != $2 AND filename NOT LIKE '%.pdf' ORDER BY created_at DESC LIMIT 1",
        [sig.account_id, filename]
      );
      if (docR3.rows.length) docR.rows.push(docR3.rows[0]);
    }

    if (!docR.rows.length) return res.status(404).send('Documento no encontrado');

    // Escribir DOCX temporal y convertir
    const tmpDocx = path.join(outputsDir, 'tmp_preview_' + Date.now() + '.docx');
    const tmpPdf = tmpDocx.replace('.docx', '.pdf');
    fs.writeFileSync(tmpDocx, docR.rows[0].doc_data);

    // Convertir DOCX a HTML con mammoth y devolver como HTML embebible
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.convertToHtml({ buffer: docR.rows[0].doc_data });
      try { fs.unlinkSync(tmpDocx); } catch(e) {}
      const html = result.value;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Georgia,serif;max-width:750px;margin:40px auto;padding:20px;font-size:14px;line-height:1.8;color:#111}h1,h2,h3{font-family:Georgia,serif}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}img{max-width:100%}p{margin-bottom:10px}</style></head><body>' + html + '</body></html>');
    } catch(mammothErr) {
      try { fs.unlinkSync(tmpDocx); } catch(e) {}
      console.error('Mammoth error:', mammothErr.message);
      res.status(500).send('Error convirtiendo documento');
    }
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// INFO endpoint - debe ir ANTES del portal
app.get('/sign/:token/info', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Token no válido' });
    const sig = r.rows[0];
    const expired = sig.expires_at && new Date(sig.expires_at) < new Date();
    res.json({
      success: true,
      document_filename: sig.document_filename,
      signer_name: sig.signer_name,
      signer_email: sig.signer_email,
      status: sig.status || 'pending',
      signed_at: sig.signed_at,
      created_at: sig.created_at,
      expires_at: sig.expires_at,
      expired,
      needs_otp: !!(sig.otp_code && !sig.otp_verified),
      group_id: sig.group_id
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// DOWNLOAD endpoint — siempre sirve PDF
app.get('/sign/:token/download', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).send('No encontrado');
    const sig = r.rows[0];
    const filename = sig.document_filename;
    const PDFDocument = require('pdf-lib').PDFDocument;
    const { rgb } = require('pdf-lib');

    // 1. Si tiene signed_pdf ya generado, servirlo
    const sigR = await pool.query('SELECT signature_data, signer_name, signed_at, signer_ip FROM signature_requests WHERE token=$1', [req.params.token]);
    const sigRow = sigR.rows[0];
    // 1. Si tiene signed_pdf generado al firmar, servirlo
    const sigPdfR = await pool.query('SELECT signed_pdf FROM signature_requests WHERE token=$1', [req.params.token]);
    const signedPdfSize = sigPdfR.rows[0]?.signed_pdf?.length || 0;
    console.log('signed_pdf size:', signedPdfSize, 'token:', req.params.token.substring(0,10));
    if (signedPdfSize > 10000) {
      const outName = filename.replace(/\.\w+$/, '') + '_firmado.pdf';
      res.set('Content-Disposition', 'attachment; filename="' + outName + '"');
      res.set('Content-Type', 'application/pdf');
      return res.send(sigPdfR.rows[0].signed_pdf);
    }

    // 2. Buscar PDF real del documento (preferir PDF sobre DOCX)
    let docData = null;
    let docFilename = filename;
    const pdfFilename = filename.replace(/\.docx$/i, '.pdf');

    // Primero buscar PDF convertido
    const pdfR = await pool.query(
      'SELECT doc_data, filename FROM documents WHERE filename=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [pdfFilename]
    );
    if (pdfR.rows.length) { docData = pdfR.rows[0].doc_data; docFilename = pdfFilename; }

    // Si no hay PDF, buscar DOCX
    if (!docData) {
      const docR = await pool.query(
        'SELECT doc_data, filename FROM documents WHERE (filename=$1 OR template_name=$1) AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [filename]
      );
      if (docR.rows.length) { docData = docR.rows[0].doc_data; docFilename = docR.rows[0].filename || filename; }
    }

    // Fallback por account
    if (!docData && sig.account_id) {
      const docR2 = await pool.query(
        "SELECT doc_data, filename FROM documents WHERE account_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [sig.account_id]
      );
      if (docR2.rows.length) { docData = docR2.rows[0].doc_data; docFilename = docR2.rows[0].filename; }
    }
    if (!docData && sig.account_id) {
      const docR3 = await pool.query(
        'SELECT doc_data, filename FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [sig.account_id]
      );
      if (docR3.rows.length) { docData = docR3.rows[0].doc_data; docFilename = docR3.rows[0].filename; }
    }

    // 3. Si tenemos PDF real y está firmado, incrustar firma en él
    if (docData && docFilename.endsWith('.pdf') && sig.status === 'signed' && sigRow?.signature_data) {
      try {
        const existingPdf = await PDFDocument.load(docData);
        const pages = existingPdf.getPages();
        const lastPage = pages[pages.length - 1];
        const { width, height } = lastPage.getSize();
        const b64 = sigRow.signature_data.replace(/^data:image\/\w+;base64,/, '');
        const imgBytes = Buffer.from(b64, 'base64');
        let sigImg;
        try { sigImg = sigRow.signature_data.includes('png') ? await existingPdf.embedPng(imgBytes) : await existingPdf.embedJpg(imgBytes); } catch(e) {}
        if (sigImg) {
          const dims = sigImg.scaleToFit(200, 80);
          lastPage.drawLine({ start:{x:40,y:120}, end:{x:width-40,y:120}, thickness:0.5, color:rgb(0.7,0.7,0.7) });
          lastPage.drawText('Firmado por: ' + (sigRow.signer_name || ''), { x:40, y:108, size:9, color:rgb(0.4,0.4,0.4) });
          lastPage.drawText('Fecha: ' + (sigRow.signed_at ? new Date(sigRow.signed_at).toLocaleString('es-MX') : ''), { x:40, y:96, size:9, color:rgb(0.4,0.4,0.4) });
          lastPage.drawText('IP: ' + (sigRow.signer_ip || ''), { x:40, y:84, size:9, color:rgb(0.4,0.4,0.4) });
          lastPage.drawImage(sigImg, { x:width-dims.width-40, y:80, width:dims.width, height:dims.height });
        }
        const signedBytes = await existingPdf.save();
        const outName = docFilename.replace('.pdf', '_firmado.pdf');
        res.set('Content-Disposition', 'attachment; filename="' + outName + '"');
        res.set('Content-Type', 'application/pdf');
        return res.send(Buffer.from(signedBytes));
      } catch(e) { console.error('PDF embed error:', e.message); }
    }

    // Si tenemos PDF real sin firma, servirlo directo
    if (docData && docFilename.endsWith('.pdf')) {
      res.set('Content-Disposition', 'attachment; filename="' + docFilename + '"');
      res.set('Content-Type', 'application/pdf');
      return res.send(docData);
    }

    // 3. Generar PDF con info del documento + firma si existe
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();

    // Header
    page.drawRectangle({ x:0, y:height-80, width, height:80, color:rgb(0.11,0.27,0.53) });
    page.drawText('DOCUMENTO DIGITAL', { x:40, y:height-35, size:20, color:rgb(1,1,1) });
    page.drawText(filename, { x:40, y:height-58, size:10, color:rgb(0.8,0.9,1) });

    // Info
    let y = height - 110;
    const info = [
      ['Documento', filename],
      ['Destinatario', sig.signer_name || '—'],
      ['Email', sig.signer_email || '—'],
      ['Estado', sig.status === 'signed' ? 'FIRMADO' : 'PENDIENTE'],
      ['Generado', sig.created_at ? new Date(sig.created_at).toLocaleString('es-MX') : '—'],
    ];
    if (sig.status === 'signed') {
      info.push(['Fecha de firma', sigRow?.signed_at ? new Date(sigRow.signed_at).toLocaleString('es-MX') : '—']);
      info.push(['IP del firmante', sigRow?.signer_ip || '—']);
    }
    for (const [label, val] of info) {
      page.drawText(label + ':', { x:40, y, size:10, color:rgb(0.4,0.4,0.4) });
      page.drawText(String(val), { x:160, y, size:10, color:rgb(0.1,0.1,0.1) });
      y -= 22;
    }

    // Firma
    if (sig.status === 'signed' && sigRow?.signature_data) {
      y -= 10;
      page.drawLine({ start:{x:40,y}, end:{x:555,y}, thickness:1, color:rgb(0.85,0.85,0.85) });
      y -= 25;
      page.drawText('FIRMA DEL FIRMANTE', { x:40, y, size:10, color:rgb(0.4,0.4,0.4) });
      y -= 15;
      try {
        const b64 = sigRow.signature_data.replace(/^data:image\/\w+;base64,/, '');
        const imgBytes = Buffer.from(b64, 'base64');
        const sigImg = sigRow.signature_data.includes('png')
          ? await pdfDoc.embedPng(imgBytes)
          : await pdfDoc.embedJpg(imgBytes);
        const dims = sigImg.scaleToFit(280, 100);
        page.drawImage(sigImg, { x:40, y:y-dims.height, width:dims.width, height:dims.height });
        y -= dims.height + 20;
      } catch(e) { console.error('Sig embed:', e.message); }
    }

    // Footer
    page.drawLine({ start:{x:40,y:60}, end:{x:555,y:60}, thickness:1, color:rgb(0.85,0.85,0.85) });
    page.drawText('Documento generado y gestionado por DocuGen · docugen-monday-production.up.railway.app', {
      x:40, y:45, size:8, color:rgb(0.6,0.6,0.6)
    });

    const pdfBytes = await pdfDoc.save();
    const pdfName = filename.replace(/\.\w+$/, '') + (sig.status === 'signed' ? '_firmado' : '') + '.pdf';
    res.set('Content-Disposition', 'attachment; filename="' + pdfName + '"');
    res.set('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));
  } catch(e) { console.error('Download error:', e); res.status(500).send('Error: ' + e.message); }
});

// PORTAL - debe ir DESPUÉS de /info y /download
app.get('/sign/:token', async (req, res) => {
  return res.sendFile(require('path').join(__dirname, 'public', 'portal.html'));
});

app.get('/sign/:token_portal_legacy', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).send('Link no válido');
    const sig = r.rows[0];
    if (sig.status === 'signed') return res.send(signedPage(sig));
    if (new Date() > new Date(sig.expires_at)) return res.send(expiredPage());
    res.send(signPage(sig));
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

app.post('/sign/:token', async (req, res) => {
  const { signature_data, signer_name } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'Firma requerida' });
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND status=$2', [req.params.token, 'pending']);
    if (!r.rows.length) return res.status(404).json({ error: 'Link no válido o ya firmado' });
    const sig = r.rows[0];
    if (new Date() > new Date(sig.expires_at)) return res.status(400).json({ error: 'Link expirado' });
    const signerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    await pool.query(
      'UPDATE signature_requests SET status=$1, signature_data=$2, signer_name=$3, signed_at=NOW(), signer_ip=$4, user_agent=$5 WHERE token=$6',
      ['signed', signature_data, signer_name || sig.signer_name, signerIp, userAgent, req.params.token]
    );

    // Generar PDF firmado: PDF real de LibreOffice + certificado de firma con pdf-lib
    try {
      const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

      // Buscar el PDF generado por LibreOffice (el real con formato)
      let pdfData = null;
      if (sig.item_id) {
        const pdfR = await pool.query(
          "SELECT doc_data, filename FROM documents WHERE item_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [String(sig.item_id)]
        );
        if (pdfR.rows.length) { pdfData = pdfR.rows[0].doc_data; console.log('PDF found:', pdfR.rows[0].filename); }
      }
      if (!pdfData && sig.account_id) {
        const pdfR2 = await pool.query(
          "SELECT doc_data, filename FROM documents WHERE account_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [sig.account_id]
        );
        if (pdfR2.rows.length) { pdfData = pdfR2.rows[0].doc_data; console.log('PDF found by account:', pdfR2.rows[0].filename); }
      }

      if (pdfData) {
        // Cargar el PDF original
        const pdfDoc = await PDFDocument.load(pdfData);
        const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

        // Agregar página de certificado
        const certPage = pdfDoc.addPage([595, 842]); // A4
        const { width, height } = certPage.getSize();
        const sigDate = new Date().toLocaleString('es-MX');
        const sigIpVal = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const finalNameVal = signer_name || sig.signer_name || '';

        // Header azul
        certPage.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: rgb(0.06, 0.12, 0.24) });
        certPage.drawText('CERTIFICADO DE FIRMA DIGITAL', { x: 30, y: height - 38, size: 18, font: helveticaBold, color: rgb(1,1,1) });
        certPage.drawText('Documento firmado electronicamente via DocuGen', { x: 30, y: height - 58, size: 10, font: helvetica, color: rgb(0.8,0.8,0.8) });

        // Badge verde
        certPage.drawRectangle({ x: 30, y: height - 110, width: 220, height: 22, color: rgb(0.82, 0.97, 0.9), borderColor: rgb(0.2, 0.6, 0.4), borderWidth: 1 });
        certPage.drawText('DOCUMENTO FIRMADO DIGITALMENTE', { x: 38, y: height - 103, size: 9, font: helveticaBold, color: rgb(0.02, 0.37, 0.25) });

        // Tabla de datos
        const rows = [
          ['Documento:', sig.document_filename || ''],
          ['Firmante:', finalNameVal],
          ['Fecha y hora:', sigDate],
          ['Direccion IP:', sigIpVal],
          ['Metodo:', req.body.signature_type || 'drawn'],
          ['Token:', req.params.token.substring(0,20) + '...'],
        ];
        let rowY = height - 145;
        for (const [label, value] of rows) {
          certPage.drawRectangle({ x: 30, y: rowY - 4, width: 160, height: 22, color: rgb(0.96, 0.96, 0.96) });
          certPage.drawRectangle({ x: 190, y: rowY - 4, width: 375, height: 22, color: rgb(1,1,1), borderColor: rgb(0.88,0.88,0.88), borderWidth: 0.5 });
          certPage.drawText(label, { x: 36, y: rowY + 4, size: 10, font: helveticaBold, color: rgb(0.3,0.3,0.3) });
          certPage.drawText(String(value).substring(0, 55), { x: 196, y: rowY + 4, size: 10, font: helvetica, color: rgb(0.1,0.1,0.1) });
          rowY -= 26;
        }

        // Imagen de firma
        if (signature_data && signature_data.startsWith('data:image')) {
          try {
            const b64 = signature_data.replace(/^data:image\/\w+;base64,/, '');
            const imgBytes = Buffer.from(b64, 'base64');
            const sigImg = signature_data.includes('image/png')
              ? await pdfDoc.embedPng(imgBytes)
              : await pdfDoc.embedJpg(imgBytes);
            certPage.drawText('FIRMA:', { x: 30, y: rowY - 10, size: 10, font: helveticaBold, color: rgb(0.3,0.3,0.3) });
            certPage.drawImage(sigImg, { x: 30, y: rowY - 100, width: 200, height: 80 });
            certPage.drawRectangle({ x: 30, y: rowY - 102, width: 204, height: 84, borderColor: rgb(0.8,0.8,0.8), borderWidth: 0.5 });
          } catch(imgErr) { console.error('Sig image embed error:', imgErr.message); }
        }

        // Footer
        certPage.drawLine({ start: { x: 30, y: 40 }, end: { x: width - 30, y: 40 }, thickness: 0.5, color: rgb(0.8,0.8,0.8) });
        certPage.drawText('Generado por DocuGen · docugen-monday-production.up.railway.app', { x: 30, y: 26, size: 8, font: helvetica, color: rgb(0.6,0.6,0.6) });

        const pdfBuffer = await pdfDoc.save();
        await pool.query(
          'UPDATE signature_requests SET signed_pdf=$1 WHERE token=$2',
          [Buffer.from(pdfBuffer), req.params.token]
        );
        console.log('PDF firmado generado:', pdfBuffer.length, 'bytes con', pdfDoc.getPageCount(), 'paginas');
      } else {
        console.log('No se encontro PDF para firmar, item_id:', sig.item_id);
      }
    } catch(embedErr) { console.error('Embed signature error FULL:', embedErr.message, embedErr.stack); }

    // Incrustar firma en el documento (legacy fallback)
    try {
      const PDFDocument = require('pdf-lib').PDFDocument;
      const { rgb } = require('pdf-lib');

      // Buscar el documento original
      const docR = await pool.query(
        'SELECT doc_data, filename FROM documents WHERE (filename=$1 OR template_name=$1) AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [sig.document_filename]
      );
      const docRow = docR.rows.length ? docR.rows[0] : null;
      const accDocR = !docRow && sig.account_id ? await pool.query(
        'SELECT doc_data, filename FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [sig.account_id]
      ) : { rows: [] };
      const finalDoc = docRow || (accDocR.rows.length ? accDocR.rows[0] : null);

      if (finalDoc && finalDoc.doc_data && signature_data && signature_data.startsWith('data:image')) {
        // Convertir docx a PDF usando html-pdf-node como fallback
        // Crear PDF simple con la firma incrustada
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595, 842]); // A4
        const { width, height } = page.getSize();

        // Título
        page.drawText('Documento firmado digitalmente', {
          x: 50, y: height - 60,
          size: 18, color: rgb(0.1, 0.1, 0.4)
        });
        page.drawText('Archivo: ' + (finalDoc.filename || sig.document_filename), {
          x: 50, y: height - 90, size: 11, color: rgb(0.3,0.3,0.3)
        });
        page.drawText('Firmante: ' + (signer_name || sig.signer_name || ''), {
          x: 50, y: height - 115, size: 11, color: rgb(0.3,0.3,0.3)
        });
        page.drawText('Fecha: ' + new Date().toLocaleString('es-MX'), {
          x: 50, y: height - 135, size: 11, color: rgb(0.3,0.3,0.3)
        });
        page.drawText('IP: ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''), {
          x: 50, y: height - 155, size: 11, color: rgb(0.3,0.3,0.3)
        });

        // Línea separadora
        page.drawLine({ start:{x:50,y:height-170}, end:{x:545,y:height-170}, thickness:1, color:rgb(0.8,0.8,0.8) });

        // Incrustar imagen de firma
        const base64Data = signature_data.replace(/^data:image\/\w+;base64,/, '');
        const sigImageBytes = Buffer.from(base64Data, 'base64');
        let sigImage;
        try {
          sigImage = signature_data.includes('image/png')
            ? await pdfDoc.embedPng(sigImageBytes)
            : await pdfDoc.embedJpg(sigImageBytes);
        } catch(e) { sigImage = await pdfDoc.embedPng(sigImageBytes).catch(()=>null); }

        if (sigImage) {
          const sigDims = sigImage.scale(0.5);
          page.drawText('Firma:', { x: 50, y: height - 210, size: 12, color: rgb(0.3,0.3,0.3) });
          page.drawImage(sigImage, {
            x: 50, y: height - 210 - sigDims.height - 10,
            width: Math.min(sigDims.width, 300),
            height: Math.min(sigDims.height, 120)
          });
        }

        // Pie de página
        page.drawText('Documento generado y firmado digitalmente por DocuGen', {
          x: 50, y: 40, size: 9, color: rgb(0.6,0.6,0.6)
        });

        const signedPdfBytes = await pdfDoc.save();
        await pool.query(
          'UPDATE signature_requests SET signed_pdf=$1 WHERE token=$2',
          [Buffer.from(signedPdfBytes), req.params.token]
        );
      }
    } catch(embedErr) { console.error('Embed signature error FULL:', embedErr.message, embedErr.stack); }

    // Notificar al firmante y buscar email del solicitante
    const downloadUrl = (process.env.APP_URL || 'https://docugen-monday-production.up.railway.app') + '/sign/' + req.params.token + '/download';
    const finalName = signer_name || sig.signer_name;

    // Email de confirmación al firmante si tiene email
    if (sig.signer_email) {
      try {
        await resend.emails.send({
          from: 'DocuGen <onboarding@resend.dev>',
          to: sig.signer_email,
          subject: '✅ Documento firmado — ' + sig.document_filename,
          html: emailSignConfirm(finalName, sig.document_filename, downloadUrl, signerIp)
        });
      } catch(e) { console.error('Email confirm error:', e.message); }
    }

    // Sincronizar con monday: actualizar columna si hay item_id
    let itemId = sig.item_id;
    try { const p = JSON.parse(itemId); if (p.id) itemId = p.id; } catch(e) {}

    if (itemId && sig.board_id) {
      try {
        // Buscar access token de la cuenta
        const accR = await pool.query('SELECT access_token FROM accounts WHERE account_id=$1', [sig.account_id]);
        if (accR.rows.length && accR.rows[0].access_token) {
          const token = accR.rows[0].access_token;
          // Actualizar columna de texto con estado de firma
          const updateQuery = `mutation {
            create_update(item_id: ${itemId}, body: "✅ Documento firmado por ${finalName} el ${new Date(sig.signed_at||new Date()).toLocaleDateString('es-MX')} — IP: ${signerIp}") { id }
          }`;
          await axios.post('https://api.monday.com/v2', { query: updateQuery }, {
            headers: { Authorization: token, 'Content-Type': 'application/json' }
          });
        }
      } catch(syncErr) { console.error('Monday sync error:', syncErr.message); }
    }

    res.json({ success: true, message: 'Documento firmado exitosamente', download_url: downloadUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/signatures', requireAuth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS signature_requests (
      id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL, account_id TEXT NOT NULL,
      document_filename TEXT NOT NULL, signer_name TEXT, signer_email TEXT,
      item_id TEXT, board_id TEXT, status TEXT DEFAULT 'pending',
      signature_data TEXT, signed_at TIMESTAMP, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT id, document_filename, signer_name, signer_email, status, signed_at, created_at, token FROM signature_requests WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50', [req.accountId]);
    res.json({ signatures: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function signPage(sig) {
  const needsOtp = sig.otp_code && !sig.otp_verified;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firma de documento</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:white;border-radius:12px;padding:28px;max-width:500px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.1)}
h2{font-size:20px;margin-bottom:6px;color:#111}
.doc-name{font-size:13px;color:#666;margin-bottom:20px;padding:8px 12px;background:#f8f8f8;border-radius:6px}
label{font-size:12px;font-weight:600;color:#444;display:block;margin-bottom:5px;margin-top:12px}
input{width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;outline:none}
input:focus{border-color:#5b6af5}
.tabs{display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #eee;padding-bottom:12px}
.tab{flex:1;padding:8px;text-align:center;border:1px solid #ddd;border-radius:7px;font-size:12px;cursor:pointer;background:#f9f9f9;transition:all 0.15s}
.tab.active{background:#5b6af5;color:white;border-color:#5b6af5}
.canvas-wrap{border:2px dashed #ddd;border-radius:8px;background:#fafafa;margin-bottom:14px;position:relative}
canvas{display:block;touch-action:none;cursor:crosshair}
.sig-type{padding:14px;border:2px dashed #ddd;border-radius:8px;margin-bottom:14px;min-height:80px;display:flex;align-items:center;justify-content:center}
.btn-row{display:flex;gap:8px;margin-top:12px}
.btn{flex:1;padding:10px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all 0.15s}
.btn-clear{background:#f5f5f5;color:#666}
.btn-submit{background:#5b6af5;color:white}
.otp-screen{text-align:center;padding:10px 0}
.otp-input{text-align:center;font-size:24px;letter-spacing:8px;font-weight:700;width:160px;margin:12px auto;display:block}
.notice{font-size:10px;color:#aaa;text-align:center;margin-top:12px}
</style></head><body>
<div class="card" id="mainCard">
  ${needsOtp ? `
  <div class="otp-screen">
    <h2>🔐 Verificar identidad</h2>
    <p style="color:#666;font-size:13px;margin:10px 0">Ingresa el código de 6 dígitos enviado a tu email</p>
    <input class="otp-input" id="otpInput" maxlength="6" placeholder="000000" type="tel">
    <div class="btn-row"><button class="btn btn-submit" onclick="verifyOtp()">Verificar →</button></div>
    <div id="otpError" style="color:#dc2626;font-size:12px;margin-top:8px"></div>
  </div>
  ` : `
  <h2>✍️ Firma requerida</h2>
  <div class="doc-name">📄 ${sig.document_filename}</div>
  <label>Tu nombre completo</label>
  <input id="signerName" value="${sig.signer_name || ''}" placeholder="Nombre del firmante">
  <label>Tipo de firma</label>
  <div class="tabs">
    <div class="tab active" onclick="setTab('draw',this)">✍ Dibujar</div>
    <div class="tab" onclick="setTab('type',this)">T Tipográfica</div>
    <div class="tab" onclick="setTab('upload',this)">⬆ Subir</div>
  </div>
  <div id="tab-draw">
    <div class="canvas-wrap"><canvas id="sigCanvas" width="444" height="150"></canvas></div>
    <button class="btn btn-clear" style="width:100%;margin-bottom:8px" onclick="clearSig()">🗑 Limpiar</button>
  </div>
  <div id="tab-type" style="display:none">
    <input id="typedSig" placeholder="Escribe tu nombre para firmar" style="font-size:20px;font-family:cursive;color:#1a1a2e;margin-bottom:8px" oninput="renderTypedSig()">
    <div class="sig-type" id="typedPreview" style="font-family:cursive;font-size:28px;color:#1a1a2e">Tu firma aparecerá aquí</div>
  </div>
  <div id="tab-upload" style="display:none">
    <div class="sig-type" onclick="document.getElementById('sigFile').click()" style="cursor:pointer;flex-direction:column;gap:8px">
      <span style="font-size:24px">⬆</span>
      <span style="font-size:12px;color:#666">Click para subir imagen de firma</span>
      <img id="uploadedSigPreview" style="max-width:200px;max-height:80px;display:none">
    </div>
    <input type="file" id="sigFile" accept="image/*" style="display:none" onchange="handleSigUpload(event)">
  </div>
  <div class="btn-row">
    <button class="btn btn-submit" onclick="submitSig()">✓ Firmar documento</button>
  </div>
  <div class="notice">🔒 Se registrará tu IP, nombre y fecha · Link expira el ${new Date(sig.expires_at).toLocaleDateString('es-MX')}</div>
  `}
</div>
<script>
const TOKEN = '${sig.token}';
let currentTab = 'draw';
let uploadedSigData = null;

async function verifyOtp() {
  const otp = document.getElementById('otpInput').value;
  const res = await fetch('/sign/' + TOKEN + '/verify-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({otp}) });
  const data = await res.json();
  if (data.success) { location.reload(); }
  else { document.getElementById('otpError').textContent = 'Código incorrecto. Intenta de nuevo.'; }
}

function setTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['draw','type','upload'].forEach(t => { document.getElementById('tab-' + t).style.display = t===tab ? 'block' : 'none'; });
}

// Canvas drawing
const canvas = document.getElementById('sigCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false, hasSig = false;
if (ctx) {
  ctx.strokeStyle='#1a1a2e'; ctx.lineWidth=2.5; ctx.lineCap='round'; ctx.lineJoin='round';
  function getPos(e) { const r=canvas.getBoundingClientRect(); const s=e.touches?e.touches[0]:e; return {x:s.clientX-r.left,y:s.clientY-r.top}; }
  canvas.addEventListener('mousedown',e=>{drawing=true;const p=getPos(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});
  canvas.addEventListener('mousemove',e=>{if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();hasSig=true});
  canvas.addEventListener('mouseup',()=>drawing=false);
  canvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;const p=getPos(e);ctx.beginPath();ctx.moveTo(p.x,p.y)},{passive:false});
  canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();hasSig=true},{passive:false});
  canvas.addEventListener('touchend',()=>drawing=false);
}
function clearSig(){if(ctx)ctx.clearRect(0,0,canvas.width,canvas.height);hasSig=false;}

function renderTypedSig() {
  const name = document.getElementById('typedSig').value;
  const preview = document.getElementById('typedPreview');
  preview.textContent = name || 'Tu firma aparecerá aquí';
}

function handleSigUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    uploadedSigData = ev.target.result;
    const img = document.getElementById('uploadedSigPreview');
    img.src = uploadedSigData; img.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function getSigData() {
  if (currentTab === 'draw') {
    if (!hasSig) { alert('Por favor dibuja tu firma'); return null; }
    return { data: canvas.toDataURL('image/png'), type: 'drawn' };
  } else if (currentTab === 'type') {
    const name = document.getElementById('typedSig').value;
    if (!name) { alert('Escribe tu nombre para firmar'); return null; }
    // Render typed signature to canvas
    const c = document.createElement('canvas'); c.width=400; c.height=100;
    const cx = c.getContext('2d');
    cx.fillStyle='white'; cx.fillRect(0,0,400,100);
    cx.font='48px cursive'; cx.fillStyle='#1a1a2e'; cx.fillText(name,20,70);
    return { data: c.toDataURL('image/png'), type: 'typed' };
  } else {
    if (!uploadedSigData) { alert('Sube una imagen de firma'); return null; }
    return { data: uploadedSigData, type: 'uploaded' };
  }
}

async function submitSig() {
  const name = document.getElementById('signerName').value;
  if (!name) { alert('Ingresa tu nombre'); return; }
  const sig = getSigData();
  if (!sig) return;
  const btn = document.querySelector('.btn-submit');
  btn.textContent='Firmando...'; btn.disabled=true;
  try {
    const res = await fetch(window.location.pathname, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({signature_data:sig.data, signer_name:name, signature_type:sig.type}) });
    const data = await res.json();
    if (data.success) {
      document.getElementById('mainCard').innerHTML='<div style="text-align:center;padding:20px"><div style="font-size:48px;margin-bottom:16px">✅</div><h2 style="color:#059669;margin-bottom:8px">¡Documento firmado!</h2><p style="color:#666;font-size:13px">Tu firma ha sido registrada exitosamente.</p>' + (data.download_url ? '<a href="'+data.download_url+'" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#059669;color:white;border-radius:8px;text-decoration:none;font-weight:600">⬇ Descargar documento</a>' : '') + '</div>';
    } else { alert('Error: '+data.error); btn.textContent='✓ Firmar'; btn.disabled=false; }
  } catch(e) { alert('Error de conexión'); btn.textContent='✓ Firmar'; btn.disabled=false; }
}
</script></body></html>`;
}


function signedPage(sig) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ya firmado</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}
  .card{background:white;border-radius:12px;padding:32px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,0.1)}</style></head>
  <body><div class="card"><div style="font-size:48px;margin-bottom:16px">✅</div>
  <h2 style="color:#059669;margin-bottom:8px">Documento ya firmado</h2>
  <p style="color:#666;font-size:13px">Este documento fue firmado el ${sig.signed_at ? new Date(sig.signed_at).toLocaleDateString('es-MX') : ''}.</p>
  </div></body></html>`;
}

function expiredPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Link expirado</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}
  .card{background:white;border-radius:12px;padding:32px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,0.1)}</style></head>
  <body><div class="card"><div style="font-size:48px;margin-bottom:16px">⏰</div>
  <h2 style="color:#dc2626;margin-bottom:8px">Link expirado</h2>
  <p style="color:#666;font-size:13px">Este link de firma ya no es válido. Solicita uno nuevo.</p>
  </div></body></html>`;
}

// ─── DESCARGAR DOCUMENTO FIRMADO ──────────────────────────
app.get('/signatures/:token/download', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND status=$2', [req.params.token, 'signed']);
    if (!r.rows.length) return res.status(404).json({ error: 'Firma no encontrada o pendiente' });
    const sig = r.rows[0];

    // Parsear item_id (puede ser JSON string o string plano)
    let itemId = sig.item_id;
    try { const parsed = JSON.parse(itemId); if (parsed.id) itemId = parsed.id; } catch(e) {}

    // Buscar el documento más reciente del item con doc_data
    const docR = await pool.query(
      'SELECT doc_data, filename FROM documents WHERE account_id=$1 AND item_id=$2 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [sig.account_id, itemId]
    );
    if (!docR.rows.length || !docR.rows[0].doc_data) return res.status(404).json({ error: 'Documento no encontrado' });

    const docBuffer = docR.rows[0].doc_data;
    const sigImgBase64 = sig.signature_data.replace(/^data:image\/png;base64,/, '');
    const sigImgBuffer = Buffer.from(sigImgBase64, 'base64');

    // Insertar firma en el docx via PizZip + XML
    const PizZip2 = require('pizzip');
    const zip2 = new PizZip2(docBuffer);
    let documentXml = zip2.file('word/document.xml').asText();

    // Agregar imagen de firma como relación
    const relsXml = zip2.file('word/_rels/document.xml.rels').asText();
    const sigRelId = 'rIdSig1';
    const newRel = '<Relationship Id="' + sigRelId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/>';
    const updatedRels = relsXml.replace('</Relationships>', newRel + '</Relationships>');
    zip2.file('word/_rels/document.xml.rels', updatedRels);
    zip2.file('word/media/signature.png', sigImgBuffer);

    // Construir XML de la sección de firma
    const sigXml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1a1a2e"/></w:rPr><w:t>FIRMA DIGITAL</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>' +
      '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<wp:extent cx="2743200" cy="914400"/>' +
      '<wp:docPr id="99" name="Firma"/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="99" name="Firma"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + sigRelId + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Firmante: ' + (sig.signer_name||'') + '</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Fecha: ' + new Date(sig.signed_at).toLocaleString('es-MX') + '</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>IP: ' + (sig.signer_ip||'N/A') + '</w:t></w:r></w:p>';

    documentXml = documentXml.replace('</w:body>', sigXml + '</w:body>');
    zip2.file('word/document.xml', documentXml);
    const modifiedDocx = zip2.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    const tmpDir = require('os').tmpdir();
    const tmpDocx = path.join(tmpDir, 'signed_' + req.params.token.slice(0,8) + '.docx');
    require('fs').writeFileSync(tmpDocx, modifiedDocx);

    // Convertir a PDF con LibreOffice
    const { execSync } = require('child_process');
    try {
      execSync(`libreoffice --headless --convert-to pdf "${tmpDocx}" --outdir "${tmpDir}"`, { timeout: 30000 });
      const pdfPath = tmpDocx.replace('.docx', '.pdf');
      if (require('fs').existsSync(pdfPath)) {
        const pdfBuffer = require('fs').readFileSync(pdfPath);
        const baseName = docR.rows[0].filename.replace('.docx', '');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="' + baseName + '_firmado.pdf"');
        return res.send(pdfBuffer);
      }
    } catch(e) { console.error('LibreOffice error:', e.message); }

    // Fallback: devolver el docx original
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', 'attachment; filename="documento_firmado.docx"');
    res.send(docBuffer);

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ver estado de firma por token
app.get('/signatures/:token/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT status, signer_name, signed_at, signer_ip FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── EMAIL TEMPLATES ──────────────────────────────────────
function emailSignRequest(signerName, docName, signUrl, expiresAt) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#5b6af5;padding:24px 28px">
      <div style="color:white;font-size:20px;font-weight:700">DocuGen</div>
      <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Plataforma de documentos digitales</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#111">Hola ${signerName},</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px">Se requiere tu firma en el siguiente documento:</p>
      <div style="background:#f8f9ff;border:1px solid #e0e4ff;border-radius:8px;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:13px;color:#666">📄 Documento</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin-top:4px">${docName}</div>
      </div>
      <a href="${signUrl}" style="display:block;text-align:center;background:#5b6af5;color:white;text-decoration:none;padding:13px;border-radius:8px;font-size:14px;font-weight:600">✍️ Firmar documento</a>
      <p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px">Este link expira el ${new Date(expiresAt).toLocaleDateString('es-MX')}</p>
      <p style="color:#aaa;font-size:11px;text-align:center;margin-top:4px">🔒 Al firmar se registrará tu IP y fecha como evidencia legal</p>
    </div>
  </div>
</body></html>`;
}

function emailSignConfirm(signerName, docName, downloadUrl, signerIp) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#059669;padding:24px 28px">
      <div style="color:white;font-size:20px;font-weight:700">✅ Documento firmado</div>
      <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">DocuGen</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#111">¡Listo, ${signerName}!</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px">Tu firma ha sido registrada exitosamente en:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:13px;color:#666">📄 Documento</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin-top:4px">${docName}</div>
        <div style="font-size:11px;color:#999;margin-top:6px">IP registrada: ${signerIp || 'N/A'}</div>
      </div>
      <a href="${downloadUrl}" style="display:block;text-align:center;background:#059669;color:white;text-decoration:none;padding:13px;border-radius:8px;font-size:14px;font-weight:600">⬇️ Descargar documento firmado</a>
    </div>
  </div>
</body></html>`;
}

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime_seconds: Math.round(uptime),
      memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
      db: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch(e) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: e.message });
  }
});

// ─── MÉTRICAS ─────────────────────────────────────────────
app.get('/metrics', requireAuth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS error_logs (
      id SERIAL PRIMARY KEY, account_id TEXT, error_type TEXT, message TEXT,
      stack TEXT, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const [docs, sigs, tpls, errors, docsToday, sigsToday] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM documents WHERE account_id=$1', [req.accountId]),
      pool.query('SELECT COUNT(*) FROM signature_requests WHERE account_id=$1', [req.accountId]),
      pool.query('SELECT COUNT(*) FROM templates WHERE account_id=$1', [req.accountId]),
      pool.query('SELECT COUNT(*) FROM error_logs WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'7 days\'', [req.accountId]),
      pool.query('SELECT COUNT(*) FROM documents WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'1 day\'', [req.accountId]),
      pool.query('SELECT COUNT(*) FROM signature_requests WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'1 day\'', [req.accountId]),
    ]);
    const docsByDay = await pool.query(
      'SELECT DATE(created_at) as day, COUNT(*) as count FROM documents WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'30 days\' GROUP BY DATE(created_at) ORDER BY day',
      [req.accountId]
    );
    const sigsByStatus = await pool.query(
      'SELECT status, COUNT(*) as count FROM signature_requests WHERE account_id=$1 GROUP BY status',
      [req.accountId]
    );
    res.json({
      totals: {
        documents: parseInt(docs.rows[0].count),
        signatures: parseInt(sigs.rows[0].count),
        templates: parseInt(tpls.rows[0].count),
        errors_7d: parseInt(errors.rows[0].count),
      },
      today: {
        documents: parseInt(docsToday.rows[0].count),
        signatures: parseInt(sigsToday.rows[0].count),
      },
      charts: {
        docs_by_day: docsByDay.rows,
        sigs_by_status: sigsByStatus.rows,
      },
      system: {
        uptime_seconds: Math.round(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        node_version: process.version,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── BACKUP AUTOMÁTICO ────────────────────────────────────
async function runBackup() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS backups (
      id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(),
      tables_backed_up INT, total_rows INT, status TEXT, error TEXT
    )`);
    // Contar filas de tablas principales
    const [d, t, s, l] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM documents'),
      pool.query('SELECT COUNT(*) FROM templates'),
      pool.query('SELECT COUNT(*) FROM signature_requests'),
      pool.query('SELECT COUNT(*) FROM logos'),
    ]);
    const totalRows = [d,t,s,l].reduce((sum, r) => sum + parseInt(r.rows[0].count), 0);

    // Exportar templates como JSON backup
    const tplData = await pool.query('SELECT account_id, filename, created_at FROM templates');
    const docData = await pool.query('SELECT account_id, item_name, template_name, filename, created_at FROM documents ORDER BY created_at DESC LIMIT 1000');

    const backupJson = JSON.stringify({
      timestamp: new Date().toISOString(),
      templates: tplData.rows,
      documents: docData.rows,
    });

    // Guardar en tabla de backups
    await pool.query(`CREATE TABLE IF NOT EXISTS backup_data (
      id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(), data TEXT
    )`);
    await pool.query('INSERT INTO backup_data (data) VALUES ($1)', [backupJson]);
    // Mantener solo los últimos 7 backups
    await pool.query('DELETE FROM backup_data WHERE id NOT IN (SELECT id FROM backup_data ORDER BY created_at DESC LIMIT 7)');
    await pool.query('INSERT INTO backups (tables_backed_up, total_rows, status) VALUES ($1,$2,$3)', [4, totalRows, 'success']);

    console.log('Backup completado:', totalRows, 'filas,', new Date().toISOString());
  } catch(e) {
    console.error('Backup error:', e.message);
    try {
      await pool.query('INSERT INTO backups (tables_backed_up, total_rows, status, error) VALUES ($1,$2,$3,$4)', [0, 0, 'error', e.message]);
      // Alertar por email si hay RESEND_API_KEY
      if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
        await resend.emails.send({
          from: 'DocuGen <onboarding@resend.dev>',
          to: process.env.ADMIN_EMAIL,
          subject: '⚠️ Error en backup de DocuGen',
          html: '<p>El backup automático falló: ' + e.message + '</p>'
        });
      }
    } catch(e2) {}
  }
}

// Backup cada 24 horas a las 3am
cron.schedule('0 3 * * *', runBackup);

// Endpoint para ver historial de backups
app.get('/backups', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, created_at, tables_backed_up, total_rows, status, error FROM backups ORDER BY created_at DESC LIMIT 10');
    res.json({ backups: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint para descargar último backup
app.get('/backups/latest', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT data, created_at FROM backup_data ORDER BY created_at DESC LIMIT 1');
    if (!r.rows.length) return res.status(404).json({ error: 'Sin backups' });
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', 'attachment; filename="docugen_backup_' + new Date().toISOString().split('T')[0] + '.json"');
    res.send(r.rows[0].data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── ERROR HANDLING & RETRY ──────────────────────────────
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch(e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

async function logError(accountId, type, message, stack) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS error_logs (
      id SERIAL PRIMARY KEY, account_id TEXT, error_type TEXT,
      message TEXT, stack TEXT, created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query('INSERT INTO error_logs (account_id, error_type, message, stack) VALUES ($1,$2,$3,$4)',
      [accountId, type, message, stack]);
  } catch(e) {}
}

// ─── EXPORTAR A XLSX ──────────────────────────────────────
app.post('/export-xlsx', requireAuth, async (req, res) => {
  const { board_id, item_id } = req.body;
  try {
    const ExcelJS = require('exceljs');
    const query = 'query { items(ids: ' + item_id + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
    const response = await axios.post('https://api.monday.com/v2', { query }, {
      headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' }
    });
    const item = response.data.data.items[0];
    const data = { nombre: item.name };
    item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
    calcularTotales(data, item.subitems, item.column_values);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DocuGen';
    const sheet = workbook.addWorksheet('Cotizacion');

    sheet.mergeCells('A1:E1');
    sheet.getCell('A1').value = 'COTIZACION — ' + data.nombre;
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF2D5BE3' } };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.getRow(1).height = 30;
    sheet.addRow([]);
    sheet.addRow(['Cliente:', data.nombre, '', 'Fecha:', data.fecha_hoy || new Date().toLocaleDateString('es-MX')]);
    sheet.addRow([]);

    const headerRow = sheet.addRow(['#', 'Producto/Servicio', 'Cantidad', 'Precio Unit.', 'Subtotal']);
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5BE3' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center' };
    });

    if (item.subitems && item.subitems.length) {
      item.subitems.forEach((sub, i) => {
        const s = { nombre: sub.name };
        sub.column_values.forEach(col => { s[toVarName(col.column.title)] = extractColumnValue(col); });
        const row = sheet.addRow([i+1, s.nombre, s.cantidad || 1, parseFloat(s.precio || 0), parseFloat(s.subtotal_linea || 0)]);
        row.getCell(4).numFmt = '"$"#,##0.00';
        row.getCell(5).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } }; });
      });
    }

    sheet.addRow([]);
    [['Subtotal:', data.subtotal_fmt||''], ['IVA (16%):', data.iva_fmt||''], ['TOTAL:', data.total_fmt||'']].forEach(([k,v], i) => {
      const row = sheet.addRow(['','','',k,v]);
      row.getCell(4).font = { bold: true, color: i===2 ? { argb: 'FF2D5BE3' } : undefined };
      row.getCell(5).font = { bold: true, color: i===2 ? { argb: 'FF2D5BE3' } : undefined };
    });

    sheet.columns = [{ width: 5 },{ width: 35 },{ width: 12 },{ width: 14 },{ width: 14 }];

    const buffer = await workbook.xlsx.writeBuffer();
    const name = (item.name||'cotizacion').replace(/[^a-zA-Z0-9]/g,'_') + '.xlsx';
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(buffer);
  } catch(e) {
    await logError(req.accountId, 'xlsx-export', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCRITURA DE COLUMNAS ────────────────────────────────
async function updateMondayColumn(accessToken, itemId, boardId, columnId, value) {
  const query = `mutation {
    change_column_value(item_id: ${itemId}, board_id: ${boardId}, column_id: "${columnId}", value: ${JSON.stringify(JSON.stringify(value))}) { id }
  }`;
  return axios.post('https://api.monday.com/v2', { query }, {
    headers: { Authorization: accessToken, 'Content-Type': 'application/json' }
  });
}

async function updateMondayStatus(accessToken, itemId, boardId, columnId, label) {
  const query = `mutation {
    change_simple_column_value(item_id: ${itemId}, board_id: ${boardId}, column_id: "${columnId}", value: "${label}") { id }
  }`;
  return axios.post('https://api.monday.com/v2', { query }, {
    headers: { Authorization: accessToken, 'Content-Type': 'application/json' }
  });
}

// Endpoint para escribir columna desde la UI
app.post('/monday/update-column', requireAuth, async (req, res) => {
  const { item_id, board_id, column_id, value, type } = req.body;
  if (!item_id || !board_id || !column_id) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    let r;
    if (type === 'status') {
      r = await updateMondayStatus(req.accessToken, item_id, board_id, column_id, value);
    } else {
      r = await updateMondayColumn(req.accessToken, item_id, board_id, column_id, value);
    }
    res.json({ success: true, data: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── WEBHOOKS DE MONDAY ───────────────────────────────────
app.post('/webhooks/monday', async (req, res) => {
  // Verificación de challenge de monday
  if (req.body.challenge) return res.json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (!event) return res.sendStatus(200);

  console.log('Monday webhook:', event.type, event.itemId);

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY, event_type TEXT, item_id TEXT, board_id TEXT,
      column_id TEXT, column_value TEXT, account_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(
      'INSERT INTO webhook_events (event_type, item_id, board_id, column_id, column_value) VALUES ($1,$2,$3,$4,$5)',
      [event.type, event.itemId, event.boardId, event.columnId, JSON.stringify(event.value)]
    );

    // Trigger: si columna de status cambia a valor configurado, auto-generar doc
    if (event.type === 'change_column_value') {
      const triggers = await pool.query(
        'SELECT * FROM webhook_triggers WHERE board_id=$1 AND column_id=$2 AND trigger_value=$3',
        [String(event.boardId), event.columnId, event.value?.label?.text || event.value]
      );
      for (const trigger of triggers.rows) {
        console.log('Trigger activado:', trigger.action, 'item:', event.itemId);
        // Guardar evento pendiente para procesar
        await pool.query(
          'INSERT INTO webhook_events (event_type, item_id, board_id, column_id, column_value, account_id) VALUES ($1,$2,$3,$4,$5,$6)',
          ['trigger_fired', String(event.itemId), String(event.boardId), trigger.template_name, 'pending', trigger.account_id]
        );
      }
    }
  } catch(e) { console.error('Webhook error:', e.message); }

  res.sendStatus(200);
});

// Configurar triggers de webhooks
app.post('/webhooks/triggers', requireAuth, async (req, res) => {
  const { board_id, column_id, trigger_value, template_name, action } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_triggers (
      id SERIAL PRIMARY KEY, account_id TEXT, board_id TEXT, column_id TEXT,
      trigger_value TEXT, template_name TEXT, action TEXT DEFAULT 'generate_doc',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(
      'INSERT INTO webhook_triggers (account_id, board_id, column_id, trigger_value, template_name, action) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.accountId, board_id, column_id, trigger_value, template_name, action || 'generate_doc']
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhooks/triggers', requireAuth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_triggers (
      id SERIAL PRIMARY KEY, account_id TEXT, board_id TEXT, column_id TEXT,
      trigger_value TEXT, template_name TEXT, action TEXT DEFAULT 'generate_doc',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM webhook_triggers WHERE account_id=$1 ORDER BY created_at DESC', [req.accountId]);
    res.json({ triggers: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/webhooks/triggers/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM webhook_triggers WHERE id=$1 AND account_id=$2', [req.params.id, req.accountId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ─── MOTOR DE AUTOMATIZACIÓN ──────────────────────────────
async function executeAutomation(accountId, itemId, boardId, templateName, accessToken) {
  try {
    const tplResult = await pool.query('SELECT data FROM templates WHERE account_id=$1 AND filename=$2', [accountId, templateName]);
    if (!tplResult.rows.length) throw new Error('Plantilla no encontrada: ' + templateName);

    const query = 'query { items(ids: ' + itemId + ') { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } subitems { id name column_values { ' + GRAPHQL_COLUMN_FRAGMENT + ' } } } }';
    const response = await withRetry(() =>
      axios.post('https://api.monday.com/v2', { query }, {
        headers: { Authorization: accessToken, 'Content-Type': 'application/json' }
      })
    );
    const item = response.data.data.items[0];
    if (!item) throw new Error('Item no encontrado: ' + itemId);

    const data = { nombre: item.name };
    item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
    calcularTotales(data, item.subitems, item.column_values);

    const zip = new PizZip(tplResult.rows[0].data);
    const doc = await createDocxtemplater(zip, accountId);
    doc.render(data);
    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_auto_' + Date.now() + '.docx';
    fs.writeFileSync(path.join(outputsDir, outputFilename), outputBuffer);

    await pool.query(
      'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [accountId, String(boardId), String(itemId), item.name, templateName, outputFilename, outputBuffer]
    );

    // Comentar en monday que se generó el doc
    const commentQuery = `mutation { create_update(item_id: ${itemId}, body: "📄 Documento generado automáticamente: ${outputFilename}") { id } }`;
    await axios.post('https://api.monday.com/v2', { query: commentQuery }, {
      headers: { Authorization: accessToken, 'Content-Type': 'application/json' }
    }).catch(e => console.error('Comment error:', e.message));

    return { success: true, filename: outputFilename };
  } catch(e) {
    await logError(accountId, 'automation', e.message, e.stack);
    return { success: false, error: e.message };
  }
}

// Procesar triggers pendientes del webhook
async function processPendingTriggers() {
  try {
    const pending = await pool.query(
      "SELECT * FROM webhook_events WHERE event_type='trigger_fired' AND column_value='pending' LIMIT 10"
    );
    for (const evt of pending.rows) {
      const trigger = await pool.query(
        'SELECT * FROM webhook_triggers WHERE account_id=$1 AND template_name=$2 LIMIT 1',
        [evt.account_id, evt.column_id]
      );
      if (!trigger.rows.length) continue;
      const acc = await pool.query('SELECT access_token FROM accounts WHERE account_id=$1', [evt.account_id]);
      if (!acc.rows.length) continue;

      const result = await executeAutomation(evt.account_id, evt.item_id, evt.board_id, evt.column_id, acc.rows[0].access_token);
      await pool.query("UPDATE webhook_events SET column_value=$1 WHERE id=$2", [result.success ? 'done' : 'error:' + result.error, evt.id]);
      console.log('Trigger procesado:', evt.item_id, result.success ? '✅' : '❌');
    }
  } catch(e) { console.error('processPendingTriggers error:', e.message); }
}

// Correr cada minuto
cron.schedule('* * * * *', processPendingTriggers);

// ─── GENERACIÓN MASIVA ────────────────────────────────────
app.post('/generate-bulk', requireAuth, async (req, res) => {
  const { board_id, item_ids, template_name } = req.body;
  if (!item_ids || !item_ids.length || !template_name) return res.status(400).json({ error: 'Faltan parámetros' });
  if (item_ids.length > 50) return res.status(400).json({ error: 'Máximo 50 items a la vez' });

  const results = [];
  for (const itemId of item_ids) {
    const r = await executeAutomation(req.accountId, itemId, board_id, template_name, req.accessToken);
    results.push({ item_id: itemId, ...r });
    await new Promise(resolve => setTimeout(resolve, 300)); // rate limit
  }
  const success = results.filter(r => r.success).length;
  res.json({ success: true, total: item_ids.length, generated: success, failed: item_ids.length - success, results });
});

// ─── AUTOMATIZACIONES PROGRAMADAS ─────────────────────────
app.post('/scheduled-automations', requireAuth, async (req, res) => {
  const { name, cron_expression, board_id, template_name, condition_column, condition_value } = req.body;
  if (!cron_expression || !board_id || !template_name) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_automations (
      id SERIAL PRIMARY KEY, account_id TEXT, name TEXT, cron_expression TEXT,
      board_id TEXT, template_name TEXT, condition_column TEXT, condition_value TEXT,
      last_run TIMESTAMP, next_run TIMESTAMP, status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(
      'INSERT INTO scheduled_automations (account_id, name, cron_expression, board_id, template_name, condition_column, condition_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.accountId, name, cron_expression, board_id, template_name, condition_column, condition_value]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/scheduled-automations', requireAuth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_automations (
      id SERIAL PRIMARY KEY, account_id TEXT, name TEXT, cron_expression TEXT,
      board_id TEXT, template_name TEXT, condition_column TEXT, condition_value TEXT,
      last_run TIMESTAMP, next_run TIMESTAMP, status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM scheduled_automations WHERE account_id=$1 ORDER BY created_at DESC', [req.accountId]);
    res.json({ automations: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/scheduled-automations/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM scheduled_automations WHERE id=$1 AND account_id=$2', [req.params.id, req.accountId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ejecutar automatizaciones programadas cada hora
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const autos = await pool.query("SELECT * FROM scheduled_automations WHERE status='active'").catch(() => ({ rows: [] }));
    for (const auto of autos.rows) {
      // Verificar si toca ejecutar según cron_expression
      // daily = cada día, weekly = cada lunes, monthly = primer día del mes
      let shouldRun = false;
      if (auto.cron_expression === 'daily') shouldRun = now.getHours() === 8;
      else if (auto.cron_expression === 'weekly') shouldRun = now.getDay() === 1 && now.getHours() === 8;
      else if (auto.cron_expression === 'monthly') shouldRun = now.getDate() === 1 && now.getHours() === 8;

      if (!shouldRun) continue;

      const acc = await pool.query('SELECT access_token FROM accounts WHERE account_id=$1', [auto.account_id]);
      if (!acc.rows.length) continue;

      // Obtener items del board
      const boardQuery = `query { boards(ids: ${auto.board_id}) { items_page(limit: 100) { items { id name column_values { id text } } } } }`;
      const boardRes = await axios.post('https://api.monday.com/v2', { query: boardQuery }, {
        headers: { Authorization: acc.rows[0].access_token, 'Content-Type': 'application/json' }
      }).catch(e => null);

      if (!boardRes) continue;
      const items = boardRes.data?.data?.boards?.[0]?.items_page?.items || [];

      for (const item of items) {
        // Aplicar condición si existe
        if (auto.condition_column && auto.condition_value) {
          const col = item.column_values.find(c => c.id === auto.condition_column);
          if (!col || col.text !== auto.condition_value) continue;
        }
        await executeAutomation(auto.account_id, item.id, auto.board_id, auto.template_name, acc.rows[0].access_token);
        await new Promise(r => setTimeout(r, 500));
      }

      await pool.query('UPDATE scheduled_automations SET last_run=$1 WHERE id=$2', [now, auto.id]);
    }
  } catch(e) { console.error('Scheduled automation error:', e.message); }
});


// ─── SISTEMA DE FIRMA AVANZADO ────────────────────────────
// Múltiples firmantes con orden
app.post('/signatures/request-multi', requireAuth, async (req, res) => {
  const { document_filename, signers, item_id, board_id } = req.body;
  // signers = [{name, email, order}, ...]
  if (!signers || !signers.length) return res.status(400).json({ error: 'Se requieren firmantes' });
  try {
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_order INT DEFAULT 1');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS group_id TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_code TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN DEFAULT FALSE');
    await pool.query("ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_type TEXT DEFAULT 'drawn'");
    await pool.query("ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE");

    const groupId = require('crypto').randomBytes(16).toString('hex');
    const tokens = [];

    for (const signer of signers) {
      const token = require('crypto').randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const order = signer.order || 1;

      await pool.query(
        'INSERT INTO signature_requests (token, account_id, document_filename, signer_name, signer_email, item_id, board_id, expires_at, signer_order, group_id, otp_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [token, req.accountId, document_filename, signer.name, signer.email, item_id, board_id, expiresAt, order, groupId, otpCode]
      );

      const signUrl = process.env.APP_URL + '/sign/' + token;

      // Solo enviar email al primero en el orden
      if (order === 1 && signer.email) {
        try {
          await resend.emails.send({
            from: 'DocuGen <onboarding@resend.dev>',
            to: signer.email,
            subject: 'Documento pendiente de tu firma — ' + document_filename,
            html: emailSignRequest(signer.name, document_filename, signUrl, expiresAt)
          });
        } catch(e) { console.error('Email error:', e.message); }
      }
      tokens.push({ name: signer.name, email: signer.email, order, token, sign_url: signUrl });
    }

    res.json({ success: true, group_id: groupId, signers: tokens });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verificar OTP
app.post('/sign/:token/verify-otp', async (req, res) => {
  const { otp } = req.body;
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Token no válido' });
    const sig = r.rows[0];
    if (sig.otp_code !== otp) return res.status(400).json({ error: 'Código incorrecto' });
    await pool.query('UPDATE signature_requests SET otp_verified=TRUE WHERE token=$1', [req.params.token]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Certificado de auditoría
app.get('/signatures/group/:groupId/certificate', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_requests WHERE group_id=$1 ORDER BY signer_order ASC', [req.params.groupId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Grupo no encontrado' });

    const htmlPdf = require('html-pdf-node');
    const certHtml = generateAuditCertificate(r.rows);
    const pdfBuffer = await htmlPdf.generatePdf({ content: certHtml }, {
      format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }, printBackground: true
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="certificado_auditoria.pdf"');
    res.send(pdfBuffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function generateAuditCertificate(signers) {
  const doc = signers[0];
  const allSigned = signers.every(s => s.status === 'signed');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; color: #111; padding: 40px; }
    .header { text-align: center; border-bottom: 3px solid #2D5BE3; padding-bottom: 20px; margin-bottom: 30px; }
    .title { font-size: 24px; font-weight: bold; color: #2D5BE3; }
    .subtitle { font-size: 14px; color: #666; margin-top: 6px; }
    .section { margin-bottom: 24px; }
    .section-title { font-size: 14px; font-weight: bold; color: #2D5BE3; border-bottom: 1px solid #eee; padding-bottom: 6px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #2D5BE3; color: white; padding: 8px; text-align: left; }
    td { padding: 8px; border-bottom: 1px solid #eee; }
    .badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; }
    .signed { background: #d1fae5; color: #065f46; }
    .pending { background: #fef3c7; color: #92400e; }
    .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 16px; }
    .hash { font-family: monospace; font-size: 10px; color: #666; background: #f5f5f5; padding: 4px 8px; border-radius: 4px; }
  </style></head><body>
  <div class="header">
    <div class="title">CERTIFICADO DE AUDITORÍA</div>
    <div class="subtitle">DocuGen — Sistema de Firma Digital</div>
    <div class="subtitle">Generado: ${new Date().toLocaleString('es-MX')}</div>
  </div>
  <div class="section">
    <div class="section-title">INFORMACIÓN DEL DOCUMENTO</div>
    <table><tr><th>Campo</th><th>Valor</th></tr>
    <tr><td>Documento</td><td>${doc.document_filename}</td></tr>
    <tr><td>Estado</td><td><span class="badge ${allSigned ? 'signed' : 'pending'}">${allSigned ? '✅ COMPLETADO' : '⏳ PENDIENTE'}</span></td></tr>
    <tr><td>Firmantes requeridos</td><td>${signers.length}</td></tr>
    <tr><td>Firmantes completados</td><td>${signers.filter(s => s.status === 'signed').length}</td></tr>
    </table>
  </div>
  <div class="section">
    <div class="section-title">REGISTRO DE FIRMAS</div>
    <table><tr><th>#</th><th>Firmante</th><th>Email</th><th>Estado</th><th>Fecha</th><th>IP</th></tr>
    ${signers.map(s => `<tr>
      <td>${s.signer_order || 1}</td>
      <td>${s.signer_name || '—'}</td>
      <td>${s.signer_email || '—'}</td>
      <td><span class="badge ${s.status === 'signed' ? 'signed' : 'pending'}">${s.status === 'signed' ? '✅ Firmado' : '⏳ Pendiente'}</span></td>
      <td>${s.signed_at ? new Date(s.signed_at).toLocaleString('es-MX') : '—'}</td>
      <td class="hash">${s.signer_ip || '—'}</td>
    </tr>`).join('')}
    </table>
  </div>
  <div class="section">
    <div class="section-title">VALIDEZ LEGAL</div>
    <p style="font-size:12px;line-height:1.8">Este certificado acredita que los firmantes indicados han completado el proceso de firma electrónica en la plataforma DocuGen. Cada firma incluye: nombre completo, dirección IP, fecha y hora exacta, y verificación de identidad por código OTP. Este documento tiene valor probatorio conforme a la legislación de firma electrónica aplicable.</p>
  </div>
  <div class="footer">
    <div>DocuGen Digital Signature Platform — ${process.env.APP_URL}</div>
    <div style="margin-top:4px">ID de grupo: <span class="hash">${signers[0]?.group_id || '—'}</span></div>
  </div>
  </body></html>`;
}
