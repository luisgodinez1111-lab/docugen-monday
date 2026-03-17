'use strict';

function emailSignRequest(signerName, docName, signUrl, expiresAt) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#5b6af5;padding:24px 28px">
      <div style="color:white;font-size:20px;font-weight:700">DocuGen</div>
      <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Plataforma de documentos digitales</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#111">Hola ${signerName},</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px">Se requiere tu firma en el siguiente documento:</p>
      <div style="background:#f8f9ff;border:1px solid #e0e4ff;border-radius:8px;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:13px;color:#666">📄 Documento</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin-top:4px">${docName}</div>
      </div>
      <a href="${signUrl}" style="display:block;text-align:center;background:#5b6af5;color:white;text-decoration:none;padding:13px;border-radius:8px;font-size:14px;font-weight:600">✍️ Firmar documento</a>
      <p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px">Este link expira el ${new Date(expiresAt).toLocaleDateString('es-MX')}</p>
      <p style="color:#aaa;font-size:11px;text-align:center;margin-top:4px">🔒 Al firmar se registrará tu IP y fecha como evidencia legal</p>
    </div>
  </div>
</body></html>`;
}

function emailSignConfirm(signerName, docName, downloadUrl, signerIp) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#059669;padding:24px 28px">
      <div style="color:white;font-size:20px;font-weight:700">✅ Documento firmado</div>
      <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">DocuGen</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#111">¡Listo, ${signerName}!</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px">Tu firma ha sido registrada exitosamente en:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:13px;color:#666">📄 Documento</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin-top:4px">${docName}</div>
        <div style="font-size:11px;color:#999;margin-top:6px">IP registrada: ${signerIp || 'N/A'}</div>
      </div>
      <a href="${downloadUrl}" style="display:block;text-align:center;background:#059669;color:white;text-decoration:none;padding:13px;border-radius:8px;font-size:14px;font-weight:600">⬇️ Descargar documento firmado</a>
    </div>
  </div>
</body></html>`;
}

module.exports = { emailSignRequest, emailSignConfirm };
