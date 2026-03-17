'use strict';

const { pool } = require('./db.service');
const storageService = require('./storage.service');

async function processDeletionQueue() {
  try {
    const result = await pool.query(`
      SELECT account_id FROM deletion_queue
      WHERE scheduled_for <= NOW() AND executed_at IS NULL
    `);
    for (const row of result.rows) {
      const accountId = row.account_id;
      try {
        // Delete S3 objects for documents and pdf_jobs belonging to this account
        const [docsResult, pdfJobsResult] = await Promise.all([
          pool.query('SELECT filename FROM documents WHERE account_id = $1', [accountId]).catch(() => ({ rows: [] })),
          pool.query('SELECT filename FROM pdf_jobs WHERE account_id = $1 AND filename IS NOT NULL', [accountId]).catch(() => ({ rows: [] })),
        ]);
        const filenames = [
          ...docsResult.rows.map(r => r.filename),
          ...pdfJobsResult.rows.map(r => r.filename),
        ];
        for (const filename of filenames) {
          if (filename) {
            await storageService.deleteFile('outputs/' + filename).catch(() => {});
          }
        }

        const tables = ['tokens','templates','documents','signature_requests','subscriptions',
          'account_settings','accounts','webhook_triggers','scheduled_automations','logos',
          'pdf_jobs','webhook_events','error_logs'];
        for (const table of tables) {
          await pool.query('DELETE FROM ' + table + ' WHERE account_id = $1', [accountId]).catch(() => {});
        }
        await pool.query('UPDATE deletion_queue SET executed_at = NOW() WHERE account_id = $1', [accountId]);
        console.info('Data deleted for uninstalled account:', accountId);
      } catch(e) { console.error('Error deleting account:', accountId, e.message); }
    }
  } catch(e) { console.error('processDeletionQueue error:', e.message); }
}

module.exports = { processDeletionQueue };
