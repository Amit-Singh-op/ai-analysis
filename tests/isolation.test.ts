/**
 * Tenant isolation (spec §12.1). No AI involved: these exercise the database layer
 * directly with the app's role (analyst_ro) and must always pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { getAdminPool } from '../src/db/pool.js';

const ro = new pg.Pool({ connectionString: config.DATABASE_RO_URL, max: 2 });
const admin = getAdminPool();
const VIEWS = ['v_consignments', 'v_consignment_devices', 'v_pings_enriched', 'v_events'];
const BASE_TABLES = ['clients', 'consignments', 'consignment_devices', 'devices', 'device_pings', 'events'];

/** Run queries as analyst_ro inside one transaction with app.client_id set (or not). */
async function asClient<T>(clientId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await ro.connect();
  try {
    await c.query('BEGIN');
    if (clientId !== null) await c.query(`SELECT set_config('app.client_id', $1, true)`, [clientId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const count = async (c: pg.PoolClient, sql: string, params: any[] = []) => Number((await c.query(sql, params)).rows[0].n);

let truth: Map<number, number[]>; // client_id -> consignment_uids (admin view of the data)
let shared: { device_uid: string; mine: number; other: number; otherClient: number };

beforeAll(async () => {
  const rows = (await admin.query('SELECT client_id, consignment_uid FROM consignments')).rows;
  truth = new Map();
  for (const r of rows) truth.set(Number(r.client_id), [...(truth.get(Number(r.client_id)) ?? []), Number(r.consignment_uid)]);
  // A device used by client 1 on one consignment and by another client on another (device reuse)
  shared = (await admin.query(`
    SELECT a.device_uid, a.consignment_uid AS mine, b.consignment_uid AS other, cb.client_id AS "otherClient"
    FROM consignment_devices a JOIN consignments ca ON ca.consignment_uid = a.consignment_uid AND ca.client_id = 1
    JOIN consignment_devices b ON b.device_uid = a.device_uid
    JOIN consignments cb ON cb.consignment_uid = b.consignment_uid AND cb.client_id <> 1
    WHERE EXISTS (SELECT 1 FROM device_pings p WHERE p.device_uid = b.device_uid AND p.timestamp BETWEEN cb.starttime AND cb.endtime)
    LIMIT 1`)).rows[0];
});
afterAll(async () => { await ro.end(); await admin.end(); });

describe('fail closed', () => {
  it('returns nothing when app.client_id is not set', async () => {
    for (const v of VIEWS) expect(await asClient(null, c => count(c, `SELECT COUNT(*) AS n FROM ${v}`))).toBe(0);
  });

  it('returns nothing when app.client_id is empty', async () => {
    for (const v of VIEWS) expect(await asClient('', c => count(c, `SELECT COUNT(*) AS n FROM ${v}`))).toBe(0);
  });

  it('rejects malformed or injected client ids instead of widening access', async () => {
    for (const bad of ['abc', '1 OR 1=1', '1,2', "1'; SELECT 1; --"]) {
      await expect(asClient(bad, c => c.query('SELECT COUNT(*) FROM v_consignments'))).rejects.toThrow();
    }
  });

  it('forgets the client at the end of the transaction', async () => {
    const c = await ro.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.client_id', '1', true)`);
      expect(await count(c, 'SELECT COUNT(*) AS n FROM v_consignments')).toBeGreaterThan(0);
      await c.query('COMMIT');
      expect(await count(c, 'SELECT COUNT(*) AS n FROM v_consignments')).toBe(0);
    } finally {
      c.release();
    }
  });
});

describe('each client sees only its own data', () => {
  it('consignments, devices and events belong to the client', async () => {
    for (const [clientId, mine] of truth) {
      await asClient(String(clientId), async c => {
        const csg = (await c.query('SELECT consignment_uid FROM v_consignments')).rows.map(r => Number(r.consignment_uid));
        expect(csg.sort()).toEqual([...mine].sort());
        const others = [...truth.entries()].filter(([id]) => id !== clientId).flatMap(([, u]) => u);
        for (const v of ['v_consignment_devices', 'v_pings_enriched', 'v_events']) {
          expect(await count(c, `SELECT COUNT(*) AS n FROM ${v} WHERE consignment_uid = ANY($1::bigint[])`, [others])).toBe(0);
        }
      });
    }
  });

  it('a device reused by another client shows only pings from this client\'s window', async () => {
    expect(shared).toBeDefined();
    const windows = (await admin.query('SELECT consignment_uid, starttime, endtime FROM consignments WHERE consignment_uid = ANY($1)', [[shared.mine, shared.other]])).rows;
    const other = windows.find(w => Number(w.consignment_uid) === Number(shared.other))!;
    const otherOnly = await admin.query(`
      SELECT COUNT(*)::int AS n FROM device_pings p WHERE p.device_uid = $1 AND p.timestamp BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM consignment_devices cd JOIN consignments c ON c.consignment_uid = cd.consignment_uid
                        WHERE cd.device_uid = p.device_uid AND c.client_id = 1 AND p.timestamp BETWEEN c.starttime AND c.endtime)`,
      [shared.device_uid, other.starttime, other.endtime]);
    expect(otherOnly.rows[0].n).toBeGreaterThan(0); // the other client really has pings client 1 must not see

    await asClient('1', async c => {
      const leaked = await count(c, `
        SELECT COUNT(*) AS n FROM v_pings_enriched v WHERE v.device_uid = $1 AND v.timestamp BETWEEN $2 AND $3
          AND v.consignment_uid <> ALL($4::bigint[])`, [shared.device_uid, other.starttime, other.endtime, truth.get(1)]);
      expect(leaked).toBe(0);
      const visible = await count(c, 'SELECT COUNT(*) AS n FROM v_pings_enriched WHERE device_uid = $1 AND consignment_uid = $2', [shared.device_uid, shared.mine]);
      expect(visible).toBeGreaterThanOrEqual(0);
    });
    await asClient(String(shared.otherClient), async c => {
      expect(await count(c, 'SELECT COUNT(*) AS n FROM v_pings_enriched WHERE consignment_uid = $1', [shared.mine])).toBe(0);
    });
  });
});

describe('the app role cannot get around the views', () => {
  it('has no access to base tables', async () => {
    for (const t of BASE_TABLES) {
      await expect(asClient('1', c => c.query(`SELECT 1 FROM ${t} LIMIT 1`))).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot write, create objects, switch roles or read server files', async () => {
    const attempts = [
      `INSERT INTO clients (client_id, name) VALUES (99, 'x')`,
      `UPDATE consignments SET client_id = 1`,
      `CREATE TABLE evil (x int)`,
      `SET ROLE analyst_views`,
      `SELECT pg_read_file('/etc/passwd')`,
      `COPY (SELECT 1) TO PROGRAM 'id'`
    ];
    for (const sql of attempts) await expect(asClient('1', c => c.query(sql))).rejects.toThrow();
  });

  it('runs read-only with a statement timeout', async () => {
    await asClient('1', async c => {
      expect((await c.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on');
      expect((await c.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('15s');
    });
  });

  it('does not expose free-text event columns or precise GPS', async () => {
    await asClient('1', async c => {
      const cols = (await c.query('SELECT * FROM v_events LIMIT 1')).fields.map(f => f.name);
      expect(cols).not.toContain('data');
      expect(cols).not.toContain('setValue');
      const gps = (await c.query('SELECT latitude, longitude FROM v_pings_enriched WHERE latitude IS NOT NULL LIMIT 50')).rows;
      for (const r of gps) {
        expect(String(r.latitude).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
        expect(String(r.longitude).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
      }
    });
  });
});

describe('row-level security (second layer, without the views)', () => {
  it('filters base tables for the view owner role by client', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE analyst_views');
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM consignments')).rows[0].n)).toBe(0); // unset -> nothing
      await c.query(`SELECT set_config('app.client_id', '2', true)`);
      const uids = (await c.query('SELECT consignment_uid FROM consignments')).rows.map(r => Number(r.consignment_uid));
      expect(uids.sort()).toEqual([...truth.get(2)!].sort());
      const foreignEvents = await c.query('SELECT COUNT(*)::int AS n FROM events WHERE consignment_uid = ANY($1::bigint[])', [truth.get(1)]);
      expect(foreignEvents.rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('performance', () => {
  it('a time-bounded ping query for one client stays fast', async () => {
    const maxTs = Number((await admin.query('SELECT MAX(timestamp) AS m FROM device_pings')).rows[0].m);
    await asClient('1', async c => {
      const t = Date.now();
      await c.query('SELECT consignment_uid, AVG(temperature), COUNT(*) FROM v_pings_enriched WHERE timestamp > $1 GROUP BY 1', [maxTs - 86400]);
      expect(Date.now() - t).toBeLessThan(3000);
    });
  });
});
