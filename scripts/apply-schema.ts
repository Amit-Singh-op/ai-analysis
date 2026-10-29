import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAdminPool } from '../src/db/pool.js';
import { config, assertLocalDatabaseUrl } from '../src/config.js';

import { createDatabaseIfNotExists } from './create-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applySchema() {
  assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'apply-schema');
  
  // 1. Ensure the database itself exists first
  await createDatabaseIfNotExists();

  console.log('[Schema] Applying database schema from database/schema.sql...');
  
  const schemaPath = path.resolve(__dirname, '../database/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  const adminPool = getAdminPool();
  const client = await adminPool.connect();

  try {
    await client.query('BEGIN');
    
    // Execute schema definitions
    await client.query(schemaSql);

    // Multi-tenant isolation: clients, client_id, analyst_ro / analyst_views roles, RLS, v_* views
    console.log('[Schema] Applying tenant isolation from database/tenancy.sql...');
    await client.query(fs.readFileSync(path.resolve(__dirname, '../database/tenancy.sql'), 'utf8'));
    const roPassword = decodeURIComponent(new URL(config.DATABASE_RO_URL).password || '').replace(/'/g, "''");
    if (roPassword) await client.query(`ALTER ROLE analyst_ro WITH LOGIN PASSWORD '${roPassword}'`);

    await client.query('COMMIT');
    console.log('[Schema] Schema and read-only permissions applied successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Schema Error] Failed to apply schema:', error);
    process.exit(1);
  } finally {
    client.release();
    await adminPool.end();
  }
}

applySchema();
