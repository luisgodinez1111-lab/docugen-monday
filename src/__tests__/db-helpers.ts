import { Pool } from 'pg';

export const testPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://testuser:testpass@localhost:5433/docugen_test',
});

export async function cleanupTestData(tables: string[]) {
  for (const table of tables.reverse()) {
    await testPool.query(`TRUNCATE ${table} CASCADE`);
  }
}

export async function closePool() {
  await testPool.end();
}
