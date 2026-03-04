const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

    console.log('📦 OAuth response:', JSON.stringify(response.data));
    const { access_token, account_id } = response.data;
    const key = account_id || 'default';
    accessTokens[key] = access_token;

    res.json({
      success: true,
      oauth_data: response.data,
      token_preview: access_token.substring(0, 15) + '...'
    });
  } catch (error) {
    console.error('❌ Error OAuth:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
  }
});

app.get('/boards', async (req, res) => {
  const { account_id } = req.query;
  const key = account_id || 'default';
  const token = accessTokens[key];

  if (!token) return res.status(401).json({ error: 'No hay token. Haz OAuth primero.', keys: Object.keys(accessTokens) });

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: `query { boards(limit:10) { id name items_count } }` },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error GraphQL', details: error.response?.data });
  }
});

app.listen(PORT, () => {
  console.log(`✅ DocuGen servidor corriendo en puerto ${PORT}`);
  console.log(`📋 ID de la aplicación: ${process.env.MONDAY_APP_ID}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
