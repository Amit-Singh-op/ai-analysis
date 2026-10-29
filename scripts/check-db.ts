/**
 * Checks the app's database role (analyst_ro): it can read the client views for a
 * client, sees nothing without one, and cannot read base tables or write.
 *
 *   npm run db:check            (checks as client 1)
 *   npm run db:check -- 2
 */
import { roPool, closePools } from '../src/db/pool.js';

const clientId = process.argv[2] ?? '1';
const VIEWS = ['v_consignments', 'v_consignment_devices', 'v_pings_enriched', 'v_events'];

async function withClient<T>(id: string | null, fn: (q: (sql: string) => Promise<any[]>) => Promise<T>): Promise<T> {
  const c = await roPool.connect();
  try {
    await c.query('BEGIN');
    if (id) await c.query(`SELECT set_config('app.client_id', $1, true)`, [id]);
    return await fn(async sql => (await c.query(sql)).rows);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

let ok = true;
const check = (pass: boolean, msg: string) => { console.log(`  ${pass ? '✓' : '✗'} ${msg}`); if (!pass) ok = false; };

try {
  console.log(`[Check-DB] Views as client ${clientId}:`);
  await withClient(clientId, async q => {
    for (const v of VIEWS) console.log(`  - ${v.padEnd(22)}: ${(await q(`SELECT COUNT(*)::int AS n FROM ${v}`))[0].n} rows`);
  });
  console.log('[Check-DB] Isolation:');
  await withClient(null, async q => check((await q('SELECT COUNT(*)::int AS n FROM v_consignments'))[0].n === 0, 'no client set → no rows'));
  for (const sql of ['SELECT 1 FROM consignments LIMIT 1', `INSERT INTO clients (client_id, name) VALUES (999, 'x')`]) {
    try { await withClient(clientId, q => q(sql)); check(false, `allowed: ${sql}`); } catch { check(true, `denied: ${sql}`); }
  }
  console.log(ok ? '\n[Check-DB] All checks passed.' : '\n[Check-DB] Some checks FAILED.');
  if (!ok) process.exitCode = 1;
} finally {
  await closePools();
}
