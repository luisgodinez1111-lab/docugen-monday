'use strict';
const { Router } = require('express');
const path = require('path');

module.exports = function makeStaticRouter(deps) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'DocuGen for monday', version: '3.0.0' });
  });

  router.get('/.well-known/monday-app-association.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({ apps: [{ clientID: '10969075' }] });
  });

  return router;
};
