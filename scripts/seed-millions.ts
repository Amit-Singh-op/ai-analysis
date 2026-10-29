import { getAdminPool, closePools } from '../src/db/pool.js';
import { runSeed } from './seed.js';

async function seedMillions() {
  console.log(`\n===============================================================`);
  console.log(` Local AI Data Analyst — Million-Row Scale Seeder`);
  console.log(` Target: 1,000,000+ Telemetry Pings, 50,000 Events, 100 Devices`);
  console.log(`===============================================================\n`);

  const startTime = Date.now();

  // Step 1: Run baseline seeder to establish core fixtures
  console.log('[Scale Seeder] Step 1: Initializing baseline fixtures (consignments, devices, planted excursions)...');
  await runSeed({
    deviceCount: 100,
    consignmentCount: 100,
    seedNumber: 42
  });

  const pool = getAdminPool();
  const client = await pool.connect();

  try {
    const anchorRes = await client.query('SELECT COALESCE(MAX(timestamp), EXTRACT(EPOCH FROM NOW())::int) as anchor FROM device_pings;');
    const anchorTime = anchorRes.rows[0].anchor;
    console.log(`[Scale Seeder] Anchor time: ${anchorTime} (${new Date(anchorTime * 1000).toISOString()})`);

    // Step 2: High-Performance Bulk Generation of 1,000,000 Telemetry Pings using PostgreSQL generate_series()
    console.log('[Scale Seeder] Step 2: Generating 1,000,000 telemetry pings via PostgreSQL kernel engine...');
    const t0 = Date.now();

    await client.query(`
      INSERT INTO device_pings (
        device_uid,
        timestamp,
        temperature,
        humidity,
        latitude,
        longitude,
        light,
        acceleration,
        battery,
        created_at
      )
      SELECT
        'DEV-' || LPAD(((g % 100) + 1)::text, 3, '0') as device_uid,
        ($1 - ((g / 100) * 300))::int as timestamp,
        ROUND((4.5 + (sin(g::numeric / 40.0) * 2.0) + ((g % 7) * 0.1))::numeric, 2)::real as temperature,
        ROUND((48.0 + (cos(g::numeric / 50.0) * 12.0) + ((g % 5) * 0.2))::numeric, 1)::real as humidity,
        ROUND((42.0 + ((g % 300) * 0.03))::numeric, 4)::real as latitude,
        ROUND((12.0 + ((g % 300) * 0.06))::numeric, 4)::real as longitude,
        CASE WHEN (g % 250 = 0) THEN 450 ELSE 15 END as light,
        CASE WHEN (g % 400 = 0) THEN 1400 ELSE 40 END as acceleration,
        ROUND(GREATEST(12.0, (99.0 - ((g / 10000.0) * 12.0)))::numeric, 1)::real as battery,
        ($1 - ((g / 100) * 300) + 2)::int as created_at
      FROM generate_series(1, 1000000) as g
      ON CONFLICT (device_uid, timestamp) DO NOTHING;
    `, [anchorTime]);

    console.log(`[Scale Seeder] 1,000,000 pings generated in ${((Date.now() - t0) / 1000).toFixed(2)}s.`);

    // Step 3: High-Performance Bulk Generation of 50,000 Events
    console.log('[Scale Seeder] Step 3: Generating 50,000 system and alert events...');
    const t1 = Date.now();

    await client.query(`
      INSERT INTO events (
        device_uid,
        consignment_uid,
        event_uid,
        timestamp,
        type,
        level,
        "setValue",
        data,
        created_at
      )
      SELECT
        'DEV-' || LPAD(((g % 100) + 1)::text, 3, '0') as device_uid,
        (1001 + (g % 50))::bigint as consignment_uid,
        'EVT-BULK-' || g as event_uid,
        ($1 - (g * 90))::int as timestamp,
        CASE 
          WHEN g % 12 = 0 THEN 'TEMPERATURE_VIOLATION'
          WHEN g % 8 = 0 THEN 'HUMIDITY_ALERT'
          WHEN g % 6 = 0 THEN 'SHOCK_EVENT'
          ELSE 'STATUS_UPDATE'
        END as type,
        CASE 
          WHEN g % 12 = 0 THEN 'CRITICAL'
          WHEN g % 4 = 0 THEN 'WARNING'
          ELSE 'INFO'
        END as level,
        '8.0' as "setValue",
        '{"scale_test": true, "recorded_temp": 9.2}' as data,
        ($1 - (g * 90))::int as created_at
      FROM generate_series(1, 50000) as g
      ON CONFLICT (event_uid) DO NOTHING;
    `, [anchorTime]);

    console.log(`[Scale Seeder] 50,000 events generated in ${((Date.now() - t1) / 1000).toFixed(2)}s.`);

    // Step 4: Run PostgreSQL ANALYZE to update statistics for cost-based optimizer
    console.log('[Scale Seeder] Step 4: Running ANALYZE to refresh PostgreSQL query planner stats...');
    await client.query('ANALYZE devices;');
    await client.query('ANALYZE consignments;');
    await client.query('ANALYZE consignment_devices;');
    await client.query('ANALYZE device_pings;');
    await client.query('ANALYZE events;');

    // Step 5: Verify Final Counts and Storage Footprint
    const counts = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM devices) as devices_count,
        (SELECT COUNT(*) FROM consignments) as consignments_count,
        (SELECT COUNT(*) FROM consignment_devices) as mappings_count,
        (SELECT COUNT(*) FROM device_pings) as pings_count,
        (SELECT COUNT(*) FROM events) as events_count,
        pg_size_pretty(pg_total_relation_size('device_pings')) as pings_disk_size,
        pg_size_pretty(pg_total_relation_size('events')) as events_disk_size,
        pg_size_pretty(pg_database_size('telemetry_db')) as total_db_size;
    `);

    const r = counts.rows[0];
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n===============================================================`);
    console.log(` SCALE SEED COMPLETE (Total elapsed: ${totalDuration}s)`);
    console.log(`===============================================================`);
    console.log(` Devices Count:        ${Number(r.devices_count).toLocaleString()}`);
    console.log(` Consignments Count:   ${Number(r.consignments_count).toLocaleString()}`);
    console.log(` Device Mappings:      ${Number(r.mappings_count).toLocaleString()}`);
    console.log(` Device Pings (Rows):  ${Number(r.pings_count).toLocaleString()}`);
    console.log(` Events (Rows):        ${Number(r.events_count).toLocaleString()}`);
    console.log(`---------------------------------------------------------------`);
    console.log(` Device Pings Table:   ${r.pings_disk_size}`);
    console.log(` Events Table:         ${r.events_disk_size}`);
    console.log(` Total Database Size:  ${r.total_db_size}`);
    console.log(`===============================================================\n`);

  } finally {
    client.release();
    await closePools();
  }
}

seedMillions().catch(err => {
  console.error('[Scale Seeder Error]', err);
  process.exit(1);
});
