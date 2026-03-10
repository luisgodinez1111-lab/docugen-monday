const fs = require('fs');
const code_original = fs.readFileSync(process.env.HOME + '/Desktop/docugen-monday/backend/index.js', 'utf8');
let code = code_original;

// ── PIEZA 1: función checkSubscription() ──
const checkSubscriptionFn = `
// ── CHECK SUBSCRIPTION (valida plan activo antes de cada operación) ──
async function checkSubscription(accountId) {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ($2,$3) ORDER BY created_at DESC LIMIT 1',
      [accountId, 'active', 'trial']
    );

    if (result.rows.length === 0) {
      // No hay suscripción — crear trial automáticamente al primer uso
      const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 días
      await pool.query(
        'INSERT INTO subscriptions (account_id, plan_id, status, docs_used, docs_limit, trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO NOTHING',
        [accountId, 'trial', 'trial', 0, 10, trialEnds]
      );
      return { allowed: true, plan: 'trial', docs_used: 0, docs_limit: 10, trial_ends_at: trialEnds };
    }

    const sub = result.rows[0];

    // Verificar si el trial expiró
    if (sub.status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) {
      await pool.query('UPDATE subscriptions SET status=$1 WHERE account_id=$2', ['expired', accountId]);
      return { allowed: false, reason: 'trial_expired', plan: 'trial' };
    }

    // Verificar límite de documentos
    if (sub.docs_used >= sub.docs_limit) {
      return { allowed: false, reason: 'docs_limit_reached', plan: sub.plan_id, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
    }

    return { allowed: true, plan: sub.plan_id, status: sub.status, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
  } catch(e) {
    console.error('checkSubscription error:', e.message);
    return { allowed: true, plan: 'unknown' }; // fail open para no bloquear en error de DB
  }
}

// ── INCREMENT DOCS USED ──
async function incrementDocsUsed(accountId) {
  try {
    await pool.query(
      'UPDATE subscriptions SET docs_used = docs_used + 1, updated_at = NOW() WHERE account_id = $1',
      [accountId]
    );
  } catch(e) {
    console.error('incrementDocsUsed error:', e.message);
  }
}
`;

// Insertar ANTES de app.listen
if (!code.includes('async function checkSubscription(')) {
  const listenIdx = code.lastIndexOf('app.listen');
  code = code.slice(0, listenIdx) + checkSubscriptionFn + '\n' + code.slice(listenIdx);
  console.log('✅ checkSubscription() + incrementDocsUsed() agregadas');
} else {
  console.log('⚠️  checkSubscription ya existe');
}

// ── PIEZA 2: endpoint /subscription/status ──
const statusEndpoint = `
// ── SUBSCRIPTION STATUS ──
app.get('/subscription/status', async (req, res) => {
  const accountId = req.query.account_id;
  if (!accountId) return res.status(400).json({ error: 'account_id requerido' });
  const status = await checkSubscription(accountId);
  res.json(status);
});
`;

if (!code.includes("'/subscription/status'")) {
  const listenIdx = code.lastIndexOf('app.listen');
  code = code.slice(0, listenIdx) + statusEndpoint + '\n' + code.slice(listenIdx);
  console.log('✅ Endpoint /subscription/status agregado');
} else {
  console.log('⚠️  /subscription/status ya existe');
}

// ── PIEZA 3: inyectar validación al inicio del endpoint /generate ──
// Buscar el endpoint y agregar el check al principio del handler
const generatePatterns = [
  "app.post('/generate',",
  'app.post("/generate",',
  "app.post('/generate', ",
  'app.post("/generate", ',
];

let genIdx = -1;
for (const p of generatePatterns) {
  genIdx = code.indexOf(p);
  if (genIdx > -1) break;
}

if (genIdx > -1) {
  // Buscar el async (req, res) => { o async(req, res) => {
  const handlerIdx = code.indexOf('async', genIdx);
  const braceIdx = code.indexOf('{', handlerIdx);

  if (braceIdx > -1 && braceIdx - genIdx < 200) {
    const insertPoint = braceIdx + 1;
    const subCheck = `
  // ── SUBSCRIPTION CHECK ──
  const _accountId = req.body.account_id || req.query.account_id;
  if (_accountId) {
    const _subCheck = await checkSubscription(_accountId);
    if (!_subCheck.allowed) {
      const msg = _subCheck.reason === 'trial_expired'
        ? 'Tu período de prueba ha expirado. Actualiza tu plan para continuar generando documentos.'
        : _subCheck.reason === 'docs_limit_reached'
          ? 'Has alcanzado el límite de documentos de tu plan (' + _subCheck.docs_used + '/' + _subCheck.docs_limit + '). Actualiza tu plan.'
          : 'Suscripción inactiva. Por favor actualiza tu plan.';
      return res.status(402).json({ error: msg, reason: _subCheck.reason, plan: _subCheck.plan });
    }
  }
`;
    if (!code.includes('SUBSCRIPTION CHECK')) {
      code = code.slice(0, insertPoint) + subCheck + code.slice(insertPoint);
      console.log('✅ Validación de suscripción inyectada en /generate');
    } else {
      console.log('⚠️  Validación ya existe en /generate');
    }
  } else {
    console.log('❌ No se encontró el handler de /generate');
  }
} else {
  console.log('❌ Endpoint /generate no encontrado');
}

// ── PIEZA 4: incrementDocsUsed después de generación exitosa ──
// Buscar el patrón donde se manda el archivo generado
const successPatterns = [
  'res.download(',
  'res.send(docBuffer',
  'res.send(pdfBuffer',
  'sendFileResult',
];

let incrementAdded = false;
for (const pattern of successPatterns) {
  const idx = code.indexOf(pattern);
  if (idx > -1 && !incrementAdded) {
    // Buscar el final de esa línea
    const lineEnd = code.indexOf('\n', idx);
    if (lineEnd > -1 && !code.includes('incrementDocsUsed')) {
      const insertion = '\n    if (_accountId) await incrementDocsUsed(_accountId); // billing';
      code = code.slice(0, lineEnd) + insertion + code.slice(lineEnd);
      console.log('✅ incrementDocsUsed() llamado después de ' + pattern);
      incrementAdded = true;
    }
    break;
  }
}
if (!incrementAdded) {
  console.log('⚠️  incrementDocsUsed no pudo inyectarse automáticamente (revisar manualmente)');
}

// Guardar
fs.writeFileSync(process.env.HOME + '/Desktop/docugen-monday/backend/index.js', code, 'utf8');
console.log('\n✅ Archivo guardado. Verificando...');

// Verificar
const final = fs.readFileSync(process.env.HOME + '/Desktop/docugen-monday/backend/index.js', 'utf8');
console.log('  checkSubscription:', final.includes('async function checkSubscription') ? '✅' : '❌');
console.log('  incrementDocsUsed:', final.includes('async function incrementDocsUsed') ? '✅' : '❌');
console.log('  /subscription/status:', final.includes("'/subscription/status'") ? '✅' : '❌');
console.log('  SUBSCRIPTION CHECK en /generate:', final.includes('SUBSCRIPTION CHECK') ? '✅' : '❌');
