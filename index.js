const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`✅ DocuGen servidor corriendo en puerto ${PORT}`);
  console.log(`📋 App ID: ${process.env.MONDAY_APP_ID}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
