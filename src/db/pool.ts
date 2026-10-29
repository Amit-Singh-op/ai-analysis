import pg from 'pg';
import { config, assertLocalDatabaseUrl } from '../config.js';

const { Pool, types } = pg;

// Parse PostgreSQL int8 (bigint) as JS numbers for clean JSON analytics
types.setTypeParser(types.builtins.INT8, (val: string) => parseInt(val, 10));

// Enforce local check on startup
assertLocalDatabaseUrl(config.DATABASE_RO_URL, 'app pool initialization');

/**
 * Tenant-scoped pool (analyst_ro): may only read the v_* views, and every query runs
 * in a transaction with app.client_id set (see runQuery in analytics/query-builder.ts).
 */
export const roPool = new Pool({
  connectionString: config.DATABASE_RO_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

/**
 * Admin pool used only by schema migrations, resets, and seed scripts.
 */
export function getAdminPool(): pg.Pool {
  assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'admin pool initialization');
  return new Pool({
    connectionString: config.DATABASE_ADMIN_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
  });
}

export async function closePools(): Promise<void> {
  await roPool.end();
}
