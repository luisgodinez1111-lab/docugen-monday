const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const templatesDir = path.join(__dirname, 'templates');
if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir);

const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir);

const storage = multer.diskStorage({
  destination: templatesDir,
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

let accessTokens = {};

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'DocuGen for monday', version: '1.0.0' });
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

    const { access_token, account_id } = response.data;
    const key = account_id || 'default';
    accessTokens[key] = access_token;

    res.json({
      success: true,
      oauth_data: response.data,
      token_preview: access_token.substring(0, 15) + '...'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
  }
});

app.get('/boards', async (req, res) => {
  const key = req.query.account_id || 'default';
  const token = accessTokens[key];
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

// Ver items y columnas de un tablero
app.post('/board-items', async (req, res) => {
  const { account_id, board_id } = req.body;
  const key = account_id || 'default';
  const token = accessTokens[key];
  if (!token) return res.status(401).json({ error: 'No hay token. Haz OAuth primero.' });

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          boards(ids: ${board_id}) {
            name
            columns { id title type }
            items_page(limit: 5) {
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

// Generar documento desde datos de monday
app.post('/generate-from-monday', async (req, res) => {
  const { account_id, board_id, item_id, template_name } = req.body;
  const key = account_id || 'default';
  const token = accessTokens[key];
  if (!token) return res.status(401).json({ error: 'No hay token.' });

  const templatePath = path.join(templatesDir, template_name);
  if (!fs.existsSync(templatePath)) {
    return res.status(404).json({ error: `Plantilla "${template_name}" no encontrada` });
  }

  try {
    // Obtener datos del item de monday
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          items(ids: ${item_id}) {
            id
            name
            column_values { id text column { title } }
          }
        }`
      },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );

    const item = response.data.data.items[0];
    
    // Construir objeto de datos para la plantilla
    const data = { nombre: item.name };
    item.column_values.forEach(col => {
      const key = col.column.title.toLowerCase().replace(/\s+/g, '_');
      data[key] = col.text || '';
    });

    console.log('📋 Datos para plantilla:', data);

    // Generar documento
    const content = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(content);
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
      message: 'Documento generado desde monday',
      filename: outputFilename,
      data_used: data,
      download_url: `/download/${outputFilename}`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Error al generar', details: error.message });
  }
});

app.post('/templates/upload', upload.single('template'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  res.json({ success: true, message: 'Plantilla subida correctamente', filename: req.file.originalname });
});

app.get('/templates', (req, res) => {
  const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.docx'));
  res.json({ templates: files });
});

app.post('/generate', async (req, res) => {
  const { template_name, data } = req.body;
  if (!template_name || !data) {
    return res.status(400).json({ error: 'Faltan template_name y data' });
  }

  const templatePath = path.join(templatesDir, template_name);
  if (!fs.existsSync(templatePath)) {
    return res.status(404).json({ error: `Plantilla "${template_name}" no encontrada` });
  }

  try {
    const content = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' }
    });

    doc.render(data);

    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = `output_${Date.now()}.docx`;
    const outputPath = path.join(outputsDir, outputFilename);
    fs.writeFileSync(outputPath, outputBuffer);

    res.json({
      success: true,
      message: 'Documento generado',
      filename: outputFilename,
      download_url: `/download/${outputFilename}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al generar documento', details: error.message });
  }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(outputsDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`✅ DocuGen servidor corriendo en puerto ${PORT}`);
  console.log(`📋 ID de la aplicación: ${process.env.MONDAY_APP_ID}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
