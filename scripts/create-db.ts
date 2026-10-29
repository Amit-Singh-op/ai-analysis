import pg from 'pg';
import { config, assertLocalDatabaseUrl } from '../src/config.js';

const { Client } = pg;

export async function createDatabaseIfNotExists() {
  assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'create-db');

  const adminUrl = new URL(config.DATABASE_ADMIN_URL);
  const targetDbName = adminUrl.pathname.replace(/^\//, '') || 'telemetry_db';

  // Connect to default 'postgres' maintenance database to check/create the target database
  const maintenanceUrl = new URL(config.DATABASE_ADMIN_URL);
  maintenanceUrl.pathname = '/postgres';

  console.log(`[Create-DB] Connecting to PostgreSQL maintenance database at ${maintenanceUrl.hostname}:${maintenanceUrl.port}...`);

  const client = new Client({
    connectionString: maintenanceUrl.toString()
  });

  try {
    await client.connect();

    // Check if database exists
    const checkRes = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDbName]
    );

    if (checkRes.rows.length === 0) {
      console.log(`[Create-DB] Database "${targetDbName}" does not exist. Creating...`);
      // Database names cannot be parameterized in CREATE DATABASE, validate identifier safely
      if (!/^[a-zA-Z0-9_]+$/.test(targetDbName)) {
        throw new Error(`Invalid database name: ${targetDbName}`);
      }
      await client.query(`CREATE DATABASE "${targetDbName}"`);
      console.log(`[Create-DB] Database "${targetDbName}" created successfully.`);
    } else {
      console.log(`[Create-DB] Database "${targetDbName}" already exists.`);
    }
  } catch (error: any) {
    console.error(`[Create-DB Error] Failed to verify/create database:`, error.message);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith('create-db.ts')) {
  createDatabaseIfNotExists().catch(() => process.exit(1));
}
