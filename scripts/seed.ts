import { getAdminPool } from '../src/db/pool.js';
import { config, assertLocalDatabaseUrl } from '../src/config.js';

// Deterministic PRNG (Mulberry32)
function createPrng(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeedOptions {
  deviceCount?: number;
  consignmentCount?: number;
  anchorTime?: number;
  seedNumber?: number;
}

/** Three demo clients; consignment N belongs to client ((N - 1001) mod 3) + 1. */
export const DEMO_CLIENTS_SQL = `INSERT INTO clients (client_id, name) VALUES
  (1, 'Acme Pharma'), (2, 'Borealis Foods'), (3, 'Cryo Labs') ON CONFLICT (client_id) DO NOTHING`;
export const demoClientFor = (consignmentUid: number) => ((((consignmentUid - 1001) % 3) + 3) % 3) + 1;

export async function runSeed(options: SeedOptions = {}) {
  assertLocalDatabaseUrl(config.DATABASE_ADMIN_URL, 'seed generator');

  const rng = createPrng(options.seedNumber ?? 42);
  const deviceCount = options.deviceCount ?? 25;
  const consignmentCount = options.consignmentCount ?? 50;

  // Anchor time: use provided, or config, or default to current time rounded to the start of current hour
  const now = options.anchorTime ?? config.ANCHOR_TIME ?? Math.floor(Date.now() / 1000);
  const anchorTime = Math.floor(now / 3600) * 3600;

  console.log(`[Seed] Starting deterministic seed generation...`);
  console.log(`[Seed] Anchor time: ${anchorTime} (${new Date(anchorTime * 1000).toISOString()})`);
  console.log(`[Seed] Generating ${deviceCount} devices and ${consignmentCount} consignments`);

  const adminPool = getAdminPool();
  const client = await adminPool.connect();

  try {
    await client.query('BEGIN');

    // 1. Clean existing records in FK-safe order
    console.log('[Seed] Cleaning local demo tables...');
    await client.query(`
      TRUNCATE TABLE events CASCADE;
      TRUNCATE TABLE device_pings CASCADE;
      TRUNCATE TABLE consignment_devices CASCADE;
      TRUNCATE TABLE consignments CASCADE;
      TRUNCATE TABLE devices CASCADE;
    `);

    // Demo tenants: consignments are spread across them so devices are reused across clients
    await client.query(DEMO_CLIENTS_SQL);

    // 2. Generate Devices (Parent Table 1)
    console.log('[Seed] Inserting devices...');
    const deviceTypes = ['COLD_CHAIN_LOGGER', 'MULTI_SENSOR_PRO', 'DRY_ICE_MONITOR', 'STANDARD_TELEMETRY'];
    const devices: { device_uid: string; device_id: string; device_type: string; created_at: number }[] = [];

    for (let i = 1; i <= deviceCount; i++) {
      const uid = `DEV-${String(i).padStart(3, '0')}`;
      const id = `DEVICE-SN-${String(1000 + i)}`;
      const type = deviceTypes[(i - 1) % deviceTypes.length];
      // created_at in epoch milliseconds (e.g., 30-90 days before anchor)
      const daysAgoMs = Math.floor(30 + rng() * 60) * 86400 * 1000;
      const createdAtMs = anchorTime * 1000 - daysAgoMs;

      devices.push({ device_uid: uid, device_id: id, device_type: type, created_at: createdAtMs });

      await client.query(
        `INSERT INTO devices (device_uid, device_id, device_type, created_at)
         VALUES ($1, $2, $3, $4)`,
        [uid, id, type, createdAtMs]
      );
    }

    // 3. Generate Consignments (Parent Table 2)
    console.log('[Seed] Inserting consignments...');
    const cityPairs = [
      { origin: 'Basel, Switzerland', destination: 'Boston, USA' },
      { origin: 'Frankfurt, Germany', destination: 'Singapore' },
      { origin: 'San Francisco, USA', destination: 'Tokyo, Japan' },
      { origin: 'Rotterdam, Netherlands', destination: 'Dubai, UAE' },
      { origin: 'London, UK', destination: 'New York, USA' },
      { origin: 'Mumbai, India', destination: 'Sydney, Australia' },
      { origin: 'Dublin, Ireland', destination: 'Chicago, USA' },
      { origin: 'Amsterdam, Netherlands', destination: 'Toronto, Canada' }
    ];

    interface ConsignmentRecord {
      uid: number;
      id: string;
      starttime: number;
      endtime: number;
      origin: string;
      destination: string;
      created_at: number;
    }

    const consignments: ConsignmentRecord[] = [];

    // Fixture 1: Active consignment yesterday with planted critical temperature excursion
    // Consignment 1001: Basel to Boston, active from anchorTime - 48h to anchorTime
    consignments.push({
      uid: 1001,
      id: 'CSG-PHARMA-1001',
      starttime: anchorTime - 48 * 3600,
      endtime: anchorTime + 6 * 3600,
      origin: 'Basel, Switzerland',
      destination: 'Boston, USA',
      created_at: anchorTime - 50 * 3600
    });

    // Fixture 2: Consignment 1002 (Frankfurt to Singapore, pristine temperature, perfectly within range)
    consignments.push({
      uid: 1002,
      id: 'CSG-VACCINE-1002',
      starttime: anchorTime - 36 * 3600,
      endtime: anchorTime + 12 * 3600,
      origin: 'Frankfurt, Germany',
      destination: 'Singapore',
      created_at: anchorTime - 40 * 3600
    });

    // Fixture 3: Consignment 1003 (SF to Tokyo, planted low battery and warning temperature)
    consignments.push({
      uid: 1003,
      id: 'CSG-BIO-1003',
      starttime: anchorTime - 24 * 3600,
      endtime: anchorTime + 24 * 3600,
      origin: 'San Francisco, USA',
      destination: 'Tokyo, Japan',
      created_at: anchorTime - 28 * 3600
    });

    // Fixture 4: Consignment 1004 (Rotterdam to Dubai, high humidity and shock)
    consignments.push({
      uid: 1004,
      id: 'CSG-PERISHABLE-1004',
      starttime: anchorTime - 30 * 3600,
      endtime: anchorTime + 10 * 3600,
      origin: 'Rotterdam, Netherlands',
      destination: 'Dubai, UAE',
      created_at: anchorTime - 35 * 3600
    });

    // Additional consignments up to consignmentCount
    for (let c = 5; c <= consignmentCount; c++) {
      const uid = 1000 + c;
      const id = `CSG-SHIP-${uid}`;
      const pair = cityPairs[c % cityPairs.length];
      // Distribute across past 7 days and future 2 days
      const offsetHours = Math.floor(rng() * 140) - 120;
      const durationHours = Math.floor(24 + rng() * 48);
      const starttime = anchorTime + offsetHours * 3600;
      const endtime = starttime + durationHours * 3600;
      const createdAt = starttime - 7200;

      consignments.push({
        uid,
        id,
        starttime,
        endtime,
        origin: pair.origin,
        destination: pair.destination,
        created_at: createdAt
      });
    }

    for (const csg of consignments) {
      await client.query(
        `INSERT INTO consignments (consignment_uid, consignment_id, starttime, endtime, origin, destination, created_at, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [csg.uid, csg.id, csg.starttime, csg.endtime, csg.origin, csg.destination, csg.created_at, demoClientFor(csg.uid)]
      );
    }

    // 4. Consignment Devices (Associates devices to consignments with threshold settings)
    console.log('[Seed] Assigning devices to consignments...');
    interface AssignmentRecord {
      device_uid: string;
      consignment_uid: number;
      temp_violation_max: number;
      temp_violation_min: number;
      temp_warning_max: number;
      temp_warning_min: number;
      collection_interval: number;
      sending_interval: number;
    }

    const assignments: AssignmentRecord[] = [
      // Fixture 1: DEV-002 on CSG-1001 (standard cold chain: 2 to 8 C, warnings at 3 and 6.5)
      {
        device_uid: 'DEV-002',
        consignment_uid: 1001,
        temp_violation_max: 8.0,
        temp_violation_min: 2.0,
        temp_warning_max: 6.5,
        temp_warning_min: 3.0,
        collection_interval: 300,
        sending_interval: 900
      },
      // Fixture 2: DEV-001 on CSG-1002 (standard cold chain)
      {
        device_uid: 'DEV-001',
        consignment_uid: 1002,
        temp_violation_max: 8.0,
        temp_violation_min: 2.0,
        temp_warning_max: 6.5,
        temp_warning_min: 3.0,
        collection_interval: 300,
        sending_interval: 900
      },
      // Fixture 3: DEV-003 on CSG-1003
      {
        device_uid: 'DEV-003',
        consignment_uid: 1003,
        temp_violation_max: 8.0,
        temp_violation_min: 2.0,
        temp_warning_max: 6.5,
        temp_warning_min: 3.0,
        collection_interval: 300,
        sending_interval: 900
      },
      // Fixture 4: DEV-005 on CSG-1004 (frozen: -25 to -15 C)
      {
        device_uid: 'DEV-005',
        consignment_uid: 1004,
        temp_violation_max: -15.0,
        temp_violation_min: -25.0,
        temp_warning_max: -17.0,
        temp_warning_min: -23.0,
        collection_interval: 300,
        sending_interval: 900
      },
      // Fixture: DEV-004 is stale (stopped reporting 36 hours ago)
      {
        device_uid: 'DEV-004',
        consignment_uid: 1005,
        temp_violation_max: 25.0,
        temp_violation_min: 15.0,
        temp_warning_max: 23.0,
        temp_warning_min: 17.0,
        collection_interval: 300,
        sending_interval: 900
      }
    ];

    // Assign remaining consignments
    for (let c = 6; c <= consignmentCount; c++) {
      const csgUid = 1000 + c;
      // 1 to 2 devices per consignment
      const assignedCount = 1 + Math.floor(rng() * 2);
      const devIndex1 = (c % deviceCount);
      const devUid1 = devices[devIndex1].device_uid;

      assignments.push({
        device_uid: devUid1,
        consignment_uid: csgUid,
        temp_violation_max: 8.0,
        temp_violation_min: 2.0,
        temp_warning_max: 6.5,
        temp_warning_min: 3.0,
        collection_interval: 300,
        sending_interval: 900
      });

      if (assignedCount > 1) {
        const devIndex2 = (devIndex1 + 3) % deviceCount;
        const devUid2 = devices[devIndex2].device_uid;
        if (devUid2 !== devUid1) {
          assignments.push({
            device_uid: devUid2,
            consignment_uid: csgUid,
            temp_violation_max: 8.0,
            temp_violation_min: 2.0,
            temp_warning_max: 6.5,
            temp_warning_min: 3.0,
            collection_interval: 300,
            sending_interval: 900
          });
        }
      }
    }

    for (const a of assignments) {
      await client.query(
        `INSERT INTO consignment_devices 
         (device_uid, consignment_uid, temp_violation_max, temp_violation_min, temp_warning_max, temp_warning_min, collection_interval, sending_interval)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (device_uid, consignment_uid) DO NOTHING`,
        [a.device_uid, a.consignment_uid, a.temp_violation_max, a.temp_violation_min, a.temp_warning_max, a.temp_warning_min, a.collection_interval, a.sending_interval]
      );
    }

    // 5. Generate Device Pings & Events
    console.log('[Seed] Generating telemetry pings and corresponding events...');
    let pingCount = 0;
    let eventCount = 0;

    // Track planted scenario for consignments
    // 10-20% scenario: Consignments 1001, 1003, 1010, 1015, 1020 have planted temperature/battery/humidity scenarios
    const plantedViolations = new Set([1001, 1010, 1015, 1020]);

    for (const a of assignments) {
      const csg = consignments.find(c => c.uid === a.consignment_uid);
      if (!csg) continue;

      // Telemetry window: from csg.starttime up to min(csg.endtime, anchorTime)
      const windowStart = csg.starttime;
      // Stale device fixture DEV-004 stops reporting 36 hours before anchor
      let windowEnd = Math.min(csg.endtime, anchorTime);
      if (a.device_uid === 'DEV-004') {
        windowEnd = Math.min(windowEnd, anchorTime - 36 * 3600);
      }

      if (windowEnd <= windowStart) continue;

      // 5-minute intervals (300 seconds), cap at 300 pings per assignment to avoid huge data
      const step = 300;
      const totalSteps = Math.min(Math.floor((windowEnd - windowStart) / step), 288); // max 24-28h of 5m pings

      const isViolationCsg = plantedViolations.has(a.consignment_uid);
      const isLowBatteryDev = a.device_uid === 'DEV-003';
      const isHumidityDev = a.device_uid === 'DEV-005';

      let currentBattery = isLowBatteryDev ? 18.0 : 95.0;

      for (let s = 0; s < totalSteps; s++) {
        const pingTime = windowStart + s * step;
        if (pingTime > anchorTime) break;

        // Base temperature
        let temp: number | null = null;
        let humidity: number | null = null;
        let light: number | null = 10;
        let acceleration: number | null = 50;

        // Missing sensor reading simulation (small percentage: ~3%)
        const isMissingReading = rng() < 0.03;

        if (!isMissingReading) {
          if (a.consignment_uid === 1001 && pingTime >= anchorTime - 20 * 3600 && pingTime <= anchorTime - 14 * 3600) {
            // Planted critical temperature excursion yesterday between -20h and -14h (peaking at 11.8 C > 8.0 C max violation)
            temp = 9.5 + rng() * 2.5; // 9.5 to 12.0 C
          } else if (a.consignment_uid === 1003 && pingTime >= anchorTime - 12 * 3600 && pingTime <= anchorTime - 8 * 3600) {
            // Planted warning temperature excursion between 6.8 C and 7.5 C (> 6.5 C warning max, < 8.0 C violation max)
            temp = 6.8 + rng() * 0.8;
          } else if (isViolationCsg && s > totalSteps / 2 && s < totalSteps * 0.7) {
            temp = a.temp_violation_max + 1.2 + rng() * 2.0;
          } else {
            // Normal in-range temperature
            const mid = (a.temp_violation_min + a.temp_violation_max) / 2;
            temp = mid + (rng() - 0.5) * 1.5;
          }

          // Humidity
          if (isHumidityDev && pingTime >= anchorTime - 16 * 3600 && pingTime <= anchorTime - 10 * 3600) {
            humidity = 82.0 + rng() * 9.0; // 82% to 91%
          } else {
            humidity = 40.0 + rng() * 15.0;
          }

          // Light & shock
          if (rng() < 0.01) {
            light = Math.floor(200 + rng() * 800);
          }
          if (isHumidityDev && s === Math.floor(totalSteps / 2)) {
            acceleration = 1850; // Shock event
          } else {
            acceleration = Math.floor(30 + rng() * 40);
          }
        }

        // Battery drain
        if (isLowBatteryDev) {
          currentBattery = Math.max(11.5, currentBattery - 0.03);
        } else {
          currentBattery = Math.max(60.0, currentBattery - 0.01);
        }
        const batteryVal = isMissingReading ? null : Number(currentBattery.toFixed(1));

        // Location coordinates (approximating route between origin and destination)
        const progressRatio = s / Math.max(totalSteps, 1);
        const lat = 45.0 + progressRatio * 5.0 + (rng() - 0.5) * 0.1;
        const lng = 8.0 + progressRatio * 20.0 + (rng() - 0.5) * 0.1;

        await client.query(
          `INSERT INTO device_pings 
           (device_uid, timestamp, temperature, humidity, latitude, longitude, light, acceleration, battery, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (device_uid, timestamp) DO NOTHING`,
          [
            a.device_uid,
            pingTime,
            temp !== null ? Number(temp.toFixed(2)) : null,
            humidity !== null ? Number(humidity.toFixed(1)) : null,
            Number(lat.toFixed(4)),
            Number(lng.toFixed(4)),
            light,
            acceleration,
            batteryVal,
            pingTime + 5
          ]
        );
        pingCount++;

        // Event Generation: Trigger consistent events for violations
        if (temp !== null) {
          if (temp > a.temp_violation_max) {
            // Generate CRITICAL event for critical excursion
            if (s % 6 === 0) { // Log event every 30m during excursion
              const eventUid = `EVT-CRIT-TEMP-${a.device_uid}-${pingTime}`;
              await client.query(
                `INSERT INTO events (device_uid, consignment_uid, event_uid, timestamp, type, level, "setValue", data, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (event_uid) DO NOTHING`,
                [
                  a.device_uid,
                  a.consignment_uid,
                  eventUid,
                  pingTime,
                  'TEMPERATURE_VIOLATION',
                  'CRITICAL',
                  a.temp_violation_max.toString(),
                  JSON.stringify({ recorded_temp: Number(temp.toFixed(2)), threshold_max: a.temp_violation_max, unit: 'CELSIUS' }),
                  pingTime
                ]
              );
              eventCount++;
            }
          } else if (temp > a.temp_warning_max) {
            if (s % 6 === 0) {
              const eventUid = `EVT-WARN-TEMP-${a.device_uid}-${pingTime}`;
              await client.query(
                `INSERT INTO events (device_uid, consignment_uid, event_uid, timestamp, type, level, "setValue", data, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (event_uid) DO NOTHING`,
                [
                  a.device_uid,
                  a.consignment_uid,
                  eventUid,
                  pingTime,
                  'TEMPERATURE_WARNING',
                  'WARNING',
                  a.temp_warning_max.toString(),
                  JSON.stringify({ recorded_temp: Number(temp.toFixed(2)), threshold_warning: a.temp_warning_max, unit: 'CELSIUS' }),
                  pingTime
                ]
              );
              eventCount++;
            }
          }
        }

        // Low battery event
        if (batteryVal !== null && batteryVal <= 15.0 && s % 12 === 0) {
          const eventUid = `EVT-WARN-BAT-${a.device_uid}-${pingTime}`;
          await client.query(
            `INSERT INTO events (device_uid, consignment_uid, event_uid, timestamp, type, level, "setValue", data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (event_uid) DO NOTHING`,
            [
              a.device_uid,
              a.consignment_uid,
              eventUid,
              pingTime,
              'BATTERY_LOW',
              'WARNING',
              '15.0',
              JSON.stringify({ battery_level: batteryVal, unit: 'PERCENT' }),
              pingTime
            ]
          );
          eventCount++;
        }

        // High humidity event
        if (humidity !== null && humidity > 80.0 && s % 6 === 0) {
          const eventUid = `EVT-WARN-HUM-${a.device_uid}-${pingTime}`;
          await client.query(
            `INSERT INTO events (device_uid, consignment_uid, event_uid, timestamp, type, level, "setValue", data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (event_uid) DO NOTHING`,
            [
              a.device_uid,
              a.consignment_uid,
              eventUid,
              pingTime,
              'HUMIDITY_HIGH',
              'WARNING',
              '80.0',
              JSON.stringify({ humidity: humidity, unit: 'PERCENT' }),
              pingTime
            ]
          );
          eventCount++;
        }

        // Shock event
        if (acceleration !== null && acceleration > 1500) {
          const eventUid = `EVT-CRIT-SHOCK-${a.device_uid}-${pingTime}`;
          await client.query(
            `INSERT INTO events (device_uid, consignment_uid, event_uid, timestamp, type, level, "setValue", data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (event_uid) DO NOTHING`,
            [
              a.device_uid,
              a.consignment_uid,
              eventUid,
              pingTime,
              'SHOCK_DETECTED',
              'CRITICAL',
              '1500',
              JSON.stringify({ acceleration_mg: acceleration, unit: 'milli-g' }),
              pingTime
            ]
          );
          eventCount++;
        }
      }
    }

    await client.query('COMMIT');
    console.log('[Seed] Database seeding committed successfully.');

    // Print counts for every table
    console.log('\n================ SEED SUMMARY COUNTS ================');
    const tables = ['devices', 'consignments', 'consignment_devices', 'device_pings', 'events'];
    for (const tbl of tables) {
      const res = await client.query(`SELECT COUNT(*)::int as count FROM "${tbl}"`);
      console.log(`  Table "${tbl.padEnd(20)}" : ${res.rows[0].count} rows`);
    }
    console.log('=====================================================\n');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Seed Error] Seeding transaction aborted:', error);
    process.exit(1);
  } finally {
    client.release();
    await adminPool.end();
  }
}

// Allow direct execution
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  runSeed();
}
