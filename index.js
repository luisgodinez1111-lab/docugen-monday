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
    await pool.query(`CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL, board_id TEXT, item_id TEXT, item_name TEXT, template_name TEXT, filename TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
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
    const result = await pool.query('SELECT filename, created_at FROM templates WHERE account_id = $1 ORDER BY created_at DESC', [accountId]);
    res.json({ templates: result.rows.map(r => r.filename) });
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

    await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename) VALUES ($1,$2,$3,$4,$5,$6)', [req.accountId, board_id, item_id, item.name, template_name, outputFilename]);

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

app.get('/download-pdf/:filename', requireAuth, async (req, res) => {
  const filename = req.params.filename;
  try {
    const result = await pool.query('SELECT pdf_data FROM pdf_jobs WHERE filename=$1 AND account_id=$2', [filename, req.accountId]);
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

app.listen(PORT, async () => {
  console.log('DocuGen servidor corriendo en puerto ' + PORT);
  console.log('App ID: ' + process.env.MONDAY_APP_ID);
  console.log('Ambiente: ' + (process.env.NODE_ENV || 'development'));
  await initDB();
});

module.exports = app;
