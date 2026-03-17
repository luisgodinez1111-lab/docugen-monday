'use strict';

const { escapeHtml } = require('./strings');

function signPage(sig) {
  const needsOtp = sig.otp_code && !sig.otp_verified;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firma de documento</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:white;border-radius:12px;padding:28px;max-width:500px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.1)}
h2{font-size:20px;margin-bottom:6px;color:#111}
.doc-name{font-size:13px;color:#666;margin-bottom:20px;padding:8px 12px;background:#f8f8f8;border-radius:6px}
label{font-size:12px;font-weight:600;color:#444;display:block;margin-bottom:5px;margin-top:12px}
input{width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;outline:none}
input:focus{border-color:#5b6af5}
.tabs{display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #eee;padding-bottom:12px}
.tab{flex:1;padding:8px;text-align:center;border:1px solid #ddd;border-radius:7px;font-size:12px;cursor:pointer;background:#f9f9f9;transition:all 0.15s}
.tab.active{background:#5b6af5;color:white;border-color:#5b6af5}
.canvas-wrap{border:2px dashed #ddd;border-radius:8px;background:#fafafa;margin-bottom:14px;position:relative}
canvas{display:block;touch-action:none;cursor:crosshair}
.sig-type{padding:14px;border:2px dashed #ddd;border-radius:8px;margin-bottom:14px;min-height:80px;display:flex;align-items:center;justify-content:center}
.btn-row{display:flex;gap:8px;margin-top:12px}
.btn{flex:1;padding:10px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all 0.15s}
.btn-clear{background:#f5f5f5;color:#666}
.btn-submit{background:#5b6af5;color:white}
.otp-screen{text-align:center;padding:10px 0}
.otp-input{text-align:center;font-size:24px;letter-spacing:8px;font-weight:700;width:160px;margin:12px auto;display:block}
.notice{font-size:10px;color:#aaa;text-align:center;margin-top:12px}
</style></head><body>
<div class="card" id="mainCard">
  ${needsOtp ? `
  <div class="otp-screen">
    <h2>🔐 Verificar identidad</h2>
    <p style="color:#666;font-size:13px;margin:10px 0">Ingresa el código de 6 dígitos enviado a tu email</p>
    <input class="otp-input" id="otpInput" maxlength="6" placeholder="000000" type="tel">
    <div class="btn-row"><button class="btn btn-submit" onclick="verifyOtp()">Verificar →</button></div>
    <div id="otpError" style="color:#dc2626;font-size:12px;margin-top:8px"></div>
  </div>
  ` : `
  <h2>✍️ Firma requerida</h2>
  <div class="doc-name">📄 ${sig.document_filename}</div>
  <label>Tu nombre completo</label>
  <input id="signerName" value="${sig.signer_name || ''}" placeholder="Nombre del firmante">
  <label>Tipo de firma</label>
  <div class="tabs">
    <div class="tab active" onclick="setTab('draw',this)">✍ Dibujar</div>
    <div class="tab" onclick="setTab('type',this)">T Tipográfica</div>
    <div class="tab" onclick="setTab('upload',this)">⬆ Subir</div>
  </div>
  <div id="tab-draw">
    <div class="canvas-wrap"><canvas id="sigCanvas" width="444" height="150"></canvas></div>
    <button class="btn btn-clear" style="width:100%;margin-bottom:8px" onclick="clearSig()">🗑 Limpiar</button>
  </div>
  <div id="tab-type" style="display:none">
    <input id="typedSig" placeholder="Escribe tu nombre para firmar" style="font-size:20px;font-family:cursive;color:#1a1a2e;margin-bottom:8px" oninput="renderTypedSig()">
    <div class="sig-type" id="typedPreview" style="font-family:cursive;font-size:28px;color:#1a1a2e">Tu firma aparecerá aquí</div>
  </div>
  <div id="tab-upload" style="display:none">
    <div class="sig-type" onclick="document.getElementById('sigFile').click()" style="cursor:pointer;flex-direction:column;gap:8px">
      <span style="font-size:24px">⬆</span>
      <span style="font-size:12px;color:#666">Click para subir imagen de firma</span>
      <img id="uploadedSigPreview" style="max-width:200px;max-height:80px;display:none">
    </div>
    <input type="file" id="sigFile" accept="image/*" style="display:none" onchange="handleSigUpload(event)">
  </div>
  <div class="btn-row">
    <button class="btn btn-submit" onclick="submitSig()">✓ Firmar documento</button>
  </div>
  <div class="notice">🔒 Se registrará tu IP, nombre y fecha · Link expira el ${new Date(sig.expires_at).toLocaleDateString('es-MX')}</div>
  `}
</div>
<script>
const TOKEN = '${sig.token}';
let currentTab = 'draw';
let uploadedSigData = null;

async function verifyOtp() {
  const otp = document.getElementById('otpInput').value;
  const res = await fetch('/sign/' + TOKEN + '/verify-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({otp}) });
  const data = await res.json();
  if (data.success) { location.reload(); }
  else { document.getElementById('otpError').textContent = 'Código incorrecto. Intenta de nuevo.'; }
}

function setTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['draw','type','upload'].forEach(t => { document.getElementById('tab-' + t).style.display = t===tab ? 'block' : 'none'; });
}

// Canvas drawing
const canvas = document.getElementById('sigCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false, hasSig = false;
if (ctx) {
  ctx.strokeStyle='#1a1a2e'; ctx.lineWidth=2.5; ctx.lineCap='round'; ctx.lineJoin='round';
  function getPos(e) { const r=canvas.getBoundingClientRect(); const s=e.touches?e.touches[0]:e; return {x:s.clientX-r.left,y:s.clientY-r.top}; }
  canvas.addEventListener('mousedown',e=>{drawing=true;const p=getPos(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});
  canvas.addEventListener('mousemove',e=>{if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();hasSig=true});
  canvas.addEventListener('mouseup',()=>drawing=false);
  canvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;const p=getPos(e);ctx.beginPath();ctx.moveTo(p.x,p.y)},{passive:false});
  canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();hasSig=true},{passive:false});
  canvas.addEventListener('touchend',()=>drawing=false);
}
function clearSig(){if(ctx)ctx.clearRect(0,0,canvas.width,canvas.height);hasSig=false;}

function renderTypedSig() {
  const name = document.getElementById('typedSig').value;
  const preview = document.getElementById('typedPreview');
  preview.textContent = name || 'Tu firma aparecerá aquí';
}

function handleSigUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    uploadedSigData = ev.target.result;
    const img = document.getElementById('uploadedSigPreview');
    img.src = uploadedSigData; img.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function getSigData() {
  if (currentTab === 'draw') {
    if (!hasSig) { alert('Por favor dibuja tu firma'); return null; }
    return { data: canvas.toDataURL('image/png'), type: 'drawn' };
  } else if (currentTab === 'type') {
    const name = document.getElementById('typedSig').value;
    if (!name) { alert('Escribe tu nombre para firmar'); return null; }
    // Render typed signature to canvas
    const c = document.createElement('canvas'); c.width=400; c.height=100;
    const cx = c.getContext('2d');
    cx.fillStyle='white'; cx.fillRect(0,0,400,100);
    cx.font='48px cursive'; cx.fillStyle='#1a1a2e'; cx.fillText(name,20,70);
    return { data: c.toDataURL('image/png'), type: 'typed' };
  } else {
    if (!uploadedSigData) { alert('Sube una imagen de firma'); return null; }
    return { data: uploadedSigData, type: 'uploaded' };
  }
}

async function submitSig() {
  const name = document.getElementById('signerName').value;
  if (!name) { alert('Ingresa tu nombre'); return; }
  const sig = getSigData();
  if (!sig) return;
  const btn = document.querySelector('.btn-submit');
  btn.textContent='Firmando...'; btn.disabled=true;
  try {
    const res = await fetch(window.location.pathname, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({signature_data:sig.data, signer_name:name, signature_type:sig.type}) });
    const data = await res.json();
    if (data.success) {
      document.getElementById('mainCard').innerHTML='<div style="text-align:center;padding:20px"><div style="font-size:48px;margin-bottom:16px">✅</div><h2 style="color:#059669;margin-bottom:8px">¡Documento firmado!</h2><p style="color:#666;font-size:13px">Tu firma ha sido registrada exitosamente.</p>' + (data.download_url ? '<a href="'+data.download_url+'" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#059669;color:white;border-radius:8px;text-decoration:none;font-weight:600">⬇ Descargar documento</a>' : '') + '</div>';
    } else { alert('Error: '+data.error); btn.textContent='✓ Firmar'; btn.disabled=false; }
  } catch(e) { alert('Error de conexión'); btn.textContent='✓ Firmar'; btn.disabled=false; }
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

function generateAuditCertificate(signers) {
  const doc = signers[0];
  const allSigned = signers.every(s => s.status === 'signed');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; color: #111; padding: 40px; }
    .header { text-align: center; border-bottom: 3px solid #2D5BE3; padding-bottom: 20px; margin-bottom: 30px; }
    .title { font-size: 24px; font-weight: bold; color: #2D5BE3; }
    .subtitle { font-size: 14px; color: #666; margin-top: 6px; }
    .section { margin-bottom: 24px; }
    .section-title { font-size: 14px; font-weight: bold; color: #2D5BE3; border-bottom: 1px solid #eee; padding-bottom: 6px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #2D5BE3; color: white; padding: 8px; text-align: left; }
    td { padding: 8px; border-bottom: 1px solid #eee; }
    .badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; }
    .signed { background: #d1fae5; color: #065f46; }
    .pending { background: #fef3c7; color: #92400e; }
    .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 16px; }
    .hash { font-family: monospace; font-size: 10px; color: #666; background: #f5f5f5; padding: 4px 8px; border-radius: 4px; }
  </style></head><body>
  <div class="header">
    <div class="title">CERTIFICADO DE AUDITORÍA</div>
    <div class="subtitle">DocuGen — Sistema de Firma Digital</div>
    <div class="subtitle">Generado: ${new Date().toLocaleString('es-MX')}</div>
  </div>
  <div class="section">
    <div class="section-title">INFORMACIÓN DEL DOCUMENTO</div>
    <table><tr><th>Campo</th><th>Valor</th></tr>
    <tr><td>Documento</td><td>${doc.document_filename}</td></tr>
    <tr><td>Estado</td><td><span class="badge ${allSigned ? 'signed' : 'pending'}">${allSigned ? '✅ COMPLETADO' : '⏳ PENDIENTE'}</span></td></tr>
    <tr><td>Firmantes requeridos</td><td>${signers.length}</td></tr>
    <tr><td>Firmantes completados</td><td>${signers.filter(s => s.status === 'signed').length}</td></tr>
    </table>
  </div>
  <div class="section">
    <div class="section-title">REGISTRO DE FIRMAS</div>
    <table><tr><th>#</th><th>Firmante</th><th>Email</th><th>Estado</th><th>Fecha</th><th>IP</th></tr>
    ${signers.map(s => `<tr>
      <td>${s.signer_order || 1}</td>
      <td>${s.signer_name || '—'}</td>
      <td>${s.signer_email || '—'}</td>
      <td><span class="badge ${s.status === 'signed' ? 'signed' : 'pending'}">${s.status === 'signed' ? '✅ Firmado' : '⏳ Pendiente'}</span></td>
      <td>${s.signed_at ? new Date(s.signed_at).toLocaleString('es-MX') : '—'}</td>
      <td class="hash">${s.signer_ip || '—'}</td>
    </tr>`).join('')}
    </table>
  </div>
  <div class="section">
    <div class="section-title">VALIDEZ LEGAL</div>
    <p style="font-size:12px;line-height:1.8">Este certificado acredita que los firmantes indicados han completado el proceso de firma electrónica en la plataforma DocuGen. Cada firma incluye: nombre completo, dirección IP, fecha y hora exacta, y verificación de identidad por código OTP. Este documento tiene valor probatorio conforme a la legislación de firma electrónica aplicable.</p>
  </div>
  <div class="footer">
    <div>DocuGen Digital Signature Platform — ${process.env.APP_URL}</div>
    <div style="margin-top:4px">ID de grupo: <span class="hash">${signers[0]?.group_id || '—'}</span></div>
  </div>
  </body></html>`;
}

module.exports = { signPage, signedPage, expiredPage, generateAuditCertificate };
