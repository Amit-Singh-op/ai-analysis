/**
 * Demo only: give existing local data a tenant. Creates three demo clients and assigns
 * every consignment without a client_id (same rule as the seed), then makes client_id
 * mandatory. Real data must be backfilled by the data owner, not by this script.
 *
 *   npm run db:tenants
 */
import { getAdminPool } from '../src/db/pool.js';
import { config, assertLocalDatabaseUrl } from '../src/config.js';
import { DEMO_CLIENTS_SQL } from './seed.js';

assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'demo tenant backfill');
const pool = getAdminPool();
try {
  await pool.query(DEMO_CLIENTS_SQL);
  const res = await pool.query(`UPDATE consignments SET client_id = (((consignment_uid - 1001) % 3) + 3) % 3 + 1 WHERE client_id IS NULL`);
  await pool.query(`ALTER TABLE consignments ALTER COLUMN client_id SET NOT NULL`);
  const counts = await pool.query(`SELECT client_id, COUNT(*)::int AS consignments FROM consignments GROUP BY 1 ORDER BY 1`);
  console.log(`[Tenants] Assigned ${res.rowCount} consignments.`, counts.rows);
} finally {
  await pool.end();
}
