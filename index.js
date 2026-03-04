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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicializar tablas
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        account_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
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
    console.log('✅ Base de datos inicializada');
  } catch (err) {
    console.error('❌ Error iniciando DB:', err.message);
  }
}

const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir);

const upload = multer({ storage: multer.memoryStorage() });

// Token helpers
async function saveToken(accountId, token) {
  await pool.query(`
    INSERT INTO tokens (account_id, access_token, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (account_id) DO UPDATE SET access_token = $2, updated_at = NOW()
  `, [accountId, token]);
}

async function getToken(accountId) {
  const res = await pool.query('SELECT access_token FROM tokens WHERE account_id = $1', [accountId]);
  return res.rows[0]?.access_token || null;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'DocuGen for monday', version: '2.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), db: !!pool });
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

    const { access_token, account_id } = response.data;
    const key = account_id?.toString() || 'default';
    await saveToken(key, access_token);
    console.log(`✅ Token guardado en DB para cuenta: ${key}`);

    res.json({
      success: true,
      message: 'Autenticación exitosa',
      account_id: key,
      token_preview: access_token.substring(0, 15) + '...'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
  }
});

app.get('/boards', async (req, res) => {
  const key = req.query.account_id || 'default';
  const token = await getToken(key);
  if (!token) return res.status(401).json({ error: 'No hay token. Haz OAuth primero.' });

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: `query { boards(limit:10) { id name items_count } }` },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error GraphQL' });
  }
});

app.post('/board-items', async (req, res) => {
  const { account_id, board_id } = req.body;
  const key = account_id || 'default';
  const token = await getToken(key);
  if (!token) return res.status(401).json({ error: 'No hay token. Haz OAuth primero.' });

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          boards(ids: ${board_id}) {
            name
            columns { id title type }
            items_page(limit: 20) {
              items {
                id
                name
                column_values { id text value column { title } }
              }
            }
          }
        }`
      },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error GraphQL', details: error.response?.data });
  }
});

// Subir plantilla a DB
app.post('/templates/upload', upload.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const accountId = req.body.account_id || 'default';

  try {
    await pool.query(`
      INSERT INTO templates (account_id, filename, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (account_id, filename) DO UPDATE SET data = $3
    `, [accountId, req.file.originalname, req.file.buffer]);

    res.json({ success: true, message: 'Plantilla guardada en base de datos', filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar plantilla', details: err.message });
  }
});

// Listar plantillas
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

// Generar documento desde monday
app.post('/generate-from-monday', async (req, res) => {
  const { account_id, board_id, item_id, template_name } = req.body;
  const key = account_id || 'default';
  const token = await getToken(key);
  if (!token) return res.status(401).json({ error: 'No hay token.' });

  try {
    // Obtener plantilla de DB
    const tplResult = await pool.query(
      'SELECT data FROM templates WHERE account_id = $1 AND filename = $2',
      [key, template_name]
    );
    if (!tplResult.rows.length) {
      return res.status(404).json({ error: `Plantilla "${template_name}" no encontrada` });
    }
    const templateBuffer = tplResult.rows[0].data;

    // Obtener datos del item de monday
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          items(ids: ${item_id}) {
            id name
            column_values { id text column { title } }
          }
        }`
      },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );

    const item = response.data.data.items[0];
    const data = { nombre: item.name };
    item.column_values.forEach(col => {
      const k = col.column.title.toLowerCase().replace(/\s+/g, '_');
      data[k] = col.text || '';
    });

    // Generar documento
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' }
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = `${item.name.replace(/\s+/g, '_')}_${Date.now()}.docx`;
    const outputPath = path.join(outputsDir, outputFilename);
    fs.writeFileSync(outputPath, outputBuffer);

    res.json({
      success: true,
      message: 'Documento generado',
      filename: outputFilename,
      data_used: data,
      download_url: `/download/${outputFilename}`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Error al generar', details: error.message });
  }
});

// Generar con datos manuales
app.post('/generate', async (req, res) => {
  const { template_name, data, account_id } = req.body;
  const key = account_id || 'default';

  try {
    const tplResult = await pool.query(
      'SELECT data FROM templates WHERE account_id = $1 AND filename = $2',
      [key, template_name]
    );
    if (!tplResult.rows.length) {
      return res.status(404).json({ error: `Plantilla "${template_name}" no encontrada` });
    }

    const zip = new PizZip(tplResult.rows[0].data);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' }
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = `output_${Date.now()}.docx`;
    fs.writeFileSync(path.join(outputsDir, outputFilename), outputBuffer);

    res.json({ success: true, filename: outputFilename, download_url: `/download/${outputFilename}` });
  } catch (error) {
    res.status(500).json({ error: 'Error al generar', details: error.message });
  }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(outputsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(filePath);
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
