import { getAdminPool } from '../src/db/pool.js';
import { config, assertLocalDatabaseUrl } from '../src/config.js';

async function resetDb() {
  // Strict localhost safety guard
  assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'db:reset');

  console.log('===============================================================');
  console.log('WARNING: DESTRICTIVE ACTION - RESETTING LOCAL DATABASE');
  console.log(`Target: ${config.DATABASE_ADMIN_URL.replace(/:[^:]*@/, ':***@')}`);
  console.log('===============================================================');

  const adminPool = getAdminPool();
  const client = await adminPool.connect();

  try {
    await client.query('BEGIN');

    console.log('[Reset-DB] Truncating tables in FK-safe order...');
    // FK safe order: child tables first, then parent tables
    await client.query(`
      TRUNCATE TABLE events CASCADE;
      TRUNCATE TABLE device_pings CASCADE;
      TRUNCATE TABLE consignment_devices CASCADE;
      TRUNCATE TABLE consignments CASCADE;
      TRUNCATE TABLE devices CASCADE;
    `);

    await client.query('COMMIT');
    console.log('[Reset-DB] All local demo tables cleared successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Reset-DB Error] Failed to reset database:', error);
    process.exit(1);
  } finally {
    client.release();
    await adminPool.end();
  }
}

resetDb();
