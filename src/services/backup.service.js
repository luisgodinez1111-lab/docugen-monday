'use strict';

const { pool } = require('./db.service');
const { sendEmail } = require('./email.service');

async function runBackup() {
  // P1-4: CREATE TABLE statements removed — backups and backup_data tables are created in initDB()
  try {
    // Contar filas de tablas principales
    const [d, t, s, l] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM documents'),
      pool.query('SELECT COUNT(*) FROM templates'),
      pool.query('SELECT COUNT(*) FROM signature_requests'),
      pool.query('SELECT COUNT(*) FROM logos'),
    ]);
    const totalRows = [d,t,s,l].reduce((sum, r) => sum + parseInt(r.rows[0].count), 0);

    // Exportar templates como JSON backup
    const tplData = await pool.query('SELECT account_id, filename, created_at FROM templates');
    const docData = await pool.query('SELECT account_id, item_name, template_name, filename, created_at FROM documents ORDER BY created_at DESC LIMIT 1000');

    const backupJson = JSON.stringify({
      timestamp: new Date().toISOString(),
      templates: tplData.rows,
      documents: docData.rows,
    });

    // Guardar en tabla de backups
    await pool.query('INSERT INTO backup_data (data) VALUES ($1)', [backupJson]);
    // Mantener solo los últimos 7 backups
    await pool.query('DELETE FROM backup_data WHERE id NOT IN (SELECT id FROM backup_data ORDER BY created_at DESC LIMIT 7)');
    await pool.query('INSERT INTO backups (tables_backed_up, total_rows, status) VALUES ($1,$2,$3)', [4, totalRows, 'success']);

    console.info('Backup completado:', totalRows, 'filas,', new Date().toISOString());
  } catch(e) {
    console.error('Backup error:', e.message);
    try {
      await pool.query('INSERT INTO backups (tables_backed_up, total_rows, status, error) VALUES ($1,$2,$3,$4)', [0, 0, 'error', e.message]);
      // Alertar por email si hay ADMIN_EMAIL configurado
      if (process.env.ADMIN_EMAIL) {
        sendEmail({
          to:      process.env.ADMIN_EMAIL,
          subject: 'Error en backup de DocuGen',
          html:    '<p>El backup automático falló: ' + e.message + '</p>',
          type:    'generic',
        }).catch(() => {});
      }
    } catch(e2) {}
  }
}

module.exports = { runBackup };
