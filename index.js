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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        account_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        user_id TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(account_id, filename)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        board_id TEXT,
        item_id TEXT,
        item_name TEXT,
        template_name TEXT,
        filename TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Base de datos inicializada');
  } catch (err) {
    console.error('❌ Error iniciando DB:', err.message);
  }
}

const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir);

const upload = multer({ storage: multer.memoryStorage() });

async function saveToken(accountId, userId, token) {
  await pool.query(`
    INSERT INTO tokens (account_id, user_id, access_token, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (account_id) DO UPDATE SET access_token = $3, user_id = $2, updated_at = NOW()
  `, [accountId, userId, token]);
}

async function getToken(accountId) {
  const res = await pool.query('SELECT access_token FROM tokens WHERE account_id = $1', [accountId]);
  return res.rows[0]?.access_token || null;
}

async function requireAuth(req, res, next) {
  const accountId = req.headers['x-account-id'] || req.query.account_id || req.body?.account_id;
  if (!accountId) return res.status(401).json({ error: 'Se requiere account_id' });
  const token = await getToken(accountId);
  if (!token) return res.status(401).json({ error: 'No hay sesión. Haz OAuth primero.', needs_auth: true });
  req.accountId = accountId;
  req.accessToken = token;
  next();
}

// Función para extraer valor de cualquier tipo de columna
function extractColumnValue(col) {
  // Para columnas mirror y board_relation usar display_value
  if (col.column?.type === 'mirror' || col.column?.type === 'board_relation') {
    return col.display_value || col.text || '';
  }
  // Para location usar solo la dirección formateada
  if (col.column?.type === 'location') {
    if (col.text) return col.text;
    try {
      const val = JSON.parse(col.value || '{}');
      return val.address || '';
    } catch(e) { return ''; }
  }
  return col.text || col.display_value || '';
}

// Función para sanitizar nombre de variable
function toVarName(title) {
  return title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'DocuGen for monday', version: '3.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/oauth/start', (req, res) => {
  const clientId = process.env.MONDAY_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}`;
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No se recibió código' });
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
    console.log(`✅ Token guardado — account: ${accountId}, user: ${userId}`);
    res.redirect(`/view?account_id=${accountId}`);
  } catch (error) {
    console.error('❌ Error OAuth:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
  }
});

app.get('/auth/check', async (req, res) => {
  const accountId = req.query.account_id;
  if (!accountId) return res.json({ authenticated: false });
  const token = await getToken(accountId);
  res.json({ authenticated: !!token, account_id: accountId });
});

app.get('/boards', requireAuth, async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: `query { boards(limit:10) { id name items_count } }` },
      { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error GraphQL' });
  }
});

app.post('/board-items', requireAuth, async (req, res) => {
  const { board_id } = req.body;
  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          boards(ids: ${board_id}) {
            name
            columns { id title type }
            items_page(limit: 50) {
              items {
                id
                name
                column_values {
                  id
                  text
                  display_value
                  value
                  column { title type }
                }
                subitems {
                  id
                  name
                  column_values {
                    id
                    text
                    display_value
                    value
                    column { title type }
                  }
                }
              }
            }
          }
        }`
      },
      { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error GraphQL', details: error.response?.data });
  }
});

// Endpoint para obtener variables disponibles de un item
app.post('/item-variables', requireAuth, async (req, res) => {
  const { board_id, item_id } = req.body;
  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          items(ids: ${item_id}) {
            id name
            column_values {
              id text display_value value
              column { title type }
            }
            subitems {
              id name
              column_values {
                id text display_value value
                column { title type }
              }
            }
          }
        }`
      },
      { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } }
    );

    const item = response.data.data.items[0];
    const variables = [{ variable: 'nombre', value: item.name, type: 'name' }];

    item.column_values.forEach(col => {
      const varName = toVarName(col.column.title);
      const value = extractColumnValue(col);
      variables.push({
        variable: varName,
        original_title: col.column.title,
        value: value || '(vacío)',
        type: col.column.type
      });
    });

    if (item.subitems?.length) {
      variables.push({
        variable: 'subelementos',
        value: `Lista de ${item.subitems.length} subelementos`,
        type: 'subitems',
        note: 'Usar {{#subelementos}}...{{/subelementos}} en la plantilla'
      });
    }

    res.json({ variables, item_name: item.name });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener variables', details: error.message });
  }
});

app.post('/templates/upload', upload.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const accountId = req.body.account_id || 'default';
  try {
    await pool.query(`
      INSERT INTO templates (account_id, filename, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (account_id, filename) DO UPDATE SET data = $3
    `, [accountId, req.file.originalname, req.file.buffer]);
    res.json({ success: true, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar plantilla', details: err.message });
  }
});

app.get('/templates', async (req, res) => {
  const accountId = req.query.account_id || 'default';
  try {
    const result = await pool.query(
      'SELECT filename, created_at FROM templates WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    res.json({ templates: result.rows.map(r => r.filename) });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar plantillas' });
  }
});

app.post('/generate-from-monday', requireAuth, async (req, res) => {
  const { board_id, item_id, template_name } = req.body;

  try {
    // Obtener plantilla de DB
    const tplResult = await pool.query(
      'SELECT data FROM templates WHERE account_id = $1 AND filename = $2',
      [req.accountId, template_name]
    );
    if (!tplResult.rows.length) {
      return res.status(404).json({ error: `Plantilla "${template_name}" no encontrada` });
    }

    // Obtener datos del item con todos los tipos de columna
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          items(ids: ${item_id}) {
            id name
            column_values {
              id text display_value value
              column { title type }
            }
            subitems {
              id name
              column_values {
                id text display_value value
                column { title type }
              }
            }
          }
        }`
      },
      { headers: { Authorization: req.accessToken, 'Content-Type': 'application/json' } }
    );

    const item = response.data.data.items[0];

    // Construir datos para la plantilla
    const data = { nombre: item.name };

    item.column_values.forEach(col => {
      const k = toVarName(col.column.title);
      data[k] = extractColumnValue(col);
    });

    // Subitems como array para loops en plantilla
    if (item.subitems?.length) {
      data.subelementos = item.subitems.map((sub, index) => {
        const subData = {
          nombre: sub.name,
          numero: index + 1
        };
        sub.column_values.forEach(col => {
          const k = toVarName(col.column.title);
          subData[k] = extractColumnValue(col);
        });
        return subData;
      });
    }

    console.log('📋 Variables para plantilla:', JSON.stringify(data, null, 2));

    // Generar documento
    const zip = new PizZip(tplResult.rows[0].data);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' }
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = `${item.name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.docx`;
    fs.writeFileSync(path.join(outputsDir, outputFilename), outputBuffer);

    await pool.query(
      'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.accountId, board_id, item_id, item.name, template_name, outputFilename]
    );

    res.json({
      success: true,
      filename: outputFilename,
      data_used: data,
      download_url: `/download/${outputFilename}`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Error al generar', details: error.message });
  }
});

app.get('/documents', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, item_name, template_name, filename, created_at FROM documents WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.accountId]
    );
    res.json({ documents: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(outputsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(filePath);
});

// Endpoint temporal de migración
app.post('/migrate', async (req, res) => {
  if (req.body.secret !== 'docugen2026') return res.status(403).json({ error: 'No autorizado' });
  try {
    await pool.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT');
    res.json({ success: true, message: 'Migración completada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

app.listen(PORT, async () => {
  console.log(`✅ DocuGen servidor corriendo en puerto ${PORT}`);
  console.log(`📋 ID de la aplicación: ${process.env.MONDAY_APP_ID}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  await initDB();
});

module.exports = app;
