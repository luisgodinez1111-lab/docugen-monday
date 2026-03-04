const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Almacenamiento temporal de tokens (en memoria)
let accessTokens = {};

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'DocuGen for monday - Servidor funcionando',
    version: '1.0.0',
    app_id: process.env.MONDAY_APP_ID
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// OAuth - Iniciar flujo
app.get('/oauth/start', (req, res) => {
  const clientId = process.env.MONDAY_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}`;
  res.redirect(authUrl);
});

// OAuth - Callback
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No se recibió código de autorización' });
  }

  try {
    const response = await axios.post('https://auth.monday.com/oauth2/token', {
      client_id: process.env.MONDAY_CLIENT_ID,
      client_secret: process.env.MONDAY_CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI
    });

    const { access_token, account_id } = response.data;
    accessTokens[account_id] = access_token;
    console.log(`✅ Token guardado para cuenta: ${account_id}`);

    res.json({
      success: true,
      message: 'Autenticación exitosa',
      account_id,
      token_preview: access_token.substring(0, 10) + '...'
    });
  } catch (error) {
    console.error('❌ Error OAuth:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al obtener token', details: error.response?.data });
  }
});

// GraphQL - Obtener tableros
app.get('/boards', async (req, res) => {
  const { account_id } = req.query;
  const token = accessTokens[account_id];

  if (!token) {
    return res.status(401).json({ error: 'No hay token para esta cuenta. Haz OAuth primero.' });
  }

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      {
        query: `query {
          boards(limit: 10) {
            id
            name
            description
            items_count
          }
        }`
      },
      {
        headers: {
          Authorization: token,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('❌ Error GraphQL:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al consultar monday.com' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ DocuGen servidor corriendo en puerto ${PORT}`);
  console.log(`📋 ID de la aplicación: ${process.env.MONDAY_APP_ID}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
