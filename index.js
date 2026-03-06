const express = require('express');
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

app.get('/', (req, res) => { res.json({ status: 'ok', message: 'DocuGen for monday', version: '3.0.0' }); });
app.get('/health', (req, res) => { res.json({ status: 'healthy', timestamp: new Date().toISOString() }); });

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

      await pool.query(
        'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename) VALUES ($1,$2,$3,$4,$5,$6)',
        [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf']
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
        await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename) VALUES ($1,$2,$3,$4,$5,$6)', [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf']);
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
    await pool.query(
      'INSERT INTO signature_requests (token, account_id, document_filename, signer_name, signer_email, item_id, board_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [token, req.accountId, document_filename, signer_name, signer_email, item_id, board_id, expiresAt]
    );
    const signUrl = process.env.APP_URL + '/sign/' + token;
    res.json({ success: true, token, sign_url: signUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/sign/:token', async (req, res) => {
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
    res.json({ success: true, message: 'Documento firmado exitosamente' });
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
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firma de documento</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:white;border-radius:12px;padding:28px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.1)}
h2{font-size:20px;margin-bottom:6px;color:#111}
.doc-name{font-size:13px;color:#666;margin-bottom:20px;padding:8px 12px;background:#f8f8f8;border-radius:6px}
label{font-size:12px;font-weight:600;color:#444;display:block;margin-bottom:5px}
input{width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:14px;outline:none}
input:focus{border-color:#5b6af5}
.canvas-wrap{border:2px dashed #ddd;border-radius:8px;background:#fafafa;margin-bottom:14px;position:relative}
canvas{display:block;touch-action:none;cursor:crosshair}
.canvas-label{position:absolute;top:8px;left:12px;font-size:11px;color:#aaa;pointer-events:none}
.btn-row{display:flex;gap:8px}
.btn{flex:1;padding:10px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all 0.15s}
.btn-clear{background:#f5f5f5;color:#666}
.btn-submit{background:#5b6af5;color:white}
.btn-submit:hover{background:#6b7aff}
.expires{font-size:11px;color:#aaa;text-align:center;margin-top:12px}
</style></head><body>
<div class="card">
  <h2>✍️ Firma requerida</h2>
  <div class="doc-name">📄 ${sig.document_filename}</div>
  <label>Tu nombre completo</label>
  <input id="signerName" value="${sig.signer_name || ''}" placeholder="Nombre del firmante">
  <label>Firma aquí abajo</label>
  <div class="canvas-wrap">
    <canvas id="sigCanvas" width="424" height="160"></canvas>
    <div class="canvas-label">Dibuja tu firma</div>
  </div>
  <div class="btn-row">
    <button class="btn btn-clear" onclick="clearSig()">🗑 Limpiar</button>
    <button class="btn btn-submit" onclick="submitSig()">✓ Firmar documento</button>
  </div>
  <div class="expires">Este link expira el ${new Date(sig.expires_at).toLocaleDateString('es-MX')}</div>
  <div style="font-size:10px;color:#aaa;text-align:center;margin-top:6px">🔒 Al firmar se registrará tu IP, nombre y fecha como evidencia legal</div>
</div>
<script>
const canvas = document.getElementById('sigCanvas');
const ctx = canvas.getContext('2d');
let drawing = false, hasSig = false;
ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - r.left, y: src.clientY - r.top };
}
canvas.addEventListener('mousedown', e => { drawing=true; const p=getPos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
canvas.addEventListener('mousemove', e => { if(!drawing) return; const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; });
canvas.addEventListener('mouseup', () => drawing=false);
canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing=true; const p=getPos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, {passive:false});
canvas.addEventListener('touchmove', e => { e.preventDefault(); if(!drawing) return; const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; }, {passive:false});
canvas.addEventListener('touchend', () => drawing=false);

function clearSig() { ctx.clearRect(0,0,canvas.width,canvas.height); hasSig=false; }

async function submitSig() {
  if (!hasSig) { alert('Por favor dibuja tu firma'); return; }
  const name = document.getElementById('signerName').value;
  if (!name) { alert('Por favor ingresa tu nombre'); return; }
  const sigData = canvas.toDataURL('image/png');
  const btn = document.querySelector('.btn-submit');
  btn.textContent = 'Firmando...'; btn.disabled = true;
  try {
    const res = await fetch(window.location.pathname, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ signature_data: sigData, signer_name: name })
    });
    const data = await res.json();
    if (data.success) {
      document.querySelector('.card').innerHTML = '<div style="text-align:center;padding:20px"><div style="font-size:48px;margin-bottom:16px">✅</div><h2 style="color:#059669;margin-bottom:8px">¡Documento firmado!</h2><p style="color:#666;font-size:13px">Tu firma ha sido registrada exitosamente.</p></div>';
    } else { alert('Error: ' + data.error); btn.textContent = '✓ Firmar'; btn.disabled=false; }
  } catch(e) { alert('Error de conexión'); btn.textContent = '✓ Firmar'; btn.disabled=false; }
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
