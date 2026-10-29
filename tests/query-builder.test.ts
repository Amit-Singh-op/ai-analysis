import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAdminPool, closePools } from '../src/db/pool.js';
import { normalizePlan, METRICS, GROUPS } from '../src/ai/planner.js';
import { buildMetricQuery, buildShipmentListQuery, buildDeviceListQuery, buildAlertListQuery, buildReadingsQuery, runQuery } from '../src/analytics/query-builder.js';
import { shipmentReport, deviceReport, compareShipments, fleetOverview, Scope } from '../src/ai/reports.js';

/**
 * The compiled queries run for one client through the views. Each result is checked against
 * independent SQL on the base tables (as admin) for the same client.
 */
const admin = getAdminPool();
let anchor: { epoch: number; iso: string };
const client = (clientId: number): Scope => ({ anchor, clientId });
const ownerOf = async (uid: number) => Number((await admin.query('SELECT client_id FROM consignments WHERE consignment_uid = $1', [uid])).rows[0].client_id);
const metric = async (clientId: number, p: object) =>
  (await runQuery(buildMetricQuery(normalizePlan({ task: 'metric', ...p }), anchor.epoch), clientId))[0];

beforeAll(async () => {
  const epoch = Number((await admin.query('SELECT MAX(timestamp) AS m FROM device_pings')).rows[0].m);
  anchor = { epoch, iso: new Date(epoch * 1000).toISOString() };
});
afterAll(async () => { await admin.end(); await closePools(); });

describe('query builder (per client, through the views)', () => {
  it('runs every metric × grouping without errors', async () => {
    for (const m of METRICS.filter(m => m !== 'none')) {
      for (const by of GROUPS) {
        await expect(runQuery(buildMetricQuery(normalizePlan({ task: 'metric', metric: m, agg: 'avg', by, window: 'last_24h' }), anchor.epoch), 1)).resolves.toBeDefined();
      }
    }
  }, 120000);

  it('refuses to run without a valid client', async () => {
    const q = buildMetricQuery(normalizePlan({ task: 'metric', metric: 'temperature', agg: 'avg' }), anchor.epoch);
    for (const bad of [0, -1, NaN, 1.5]) await expect(runQuery(q, bad)).rejects.toThrow(/valid client/);
  });

  it('matches known numbers for the owning client', async () => {
    const c1001 = await ownerOf(1001), c1002 = await ownerOf(1002);
    expect(Number((await metric(c1001, { metric: 'time_out_of_range', window: 'last_7d', shipments: [1001] })).value)).toBe(285);
    expect(Number((await metric(c1001, { metric: 'violations', window: 'last_7d', shipments: [1001] })).value)).toBe(57);
    expect(Number((await metric(c1002, { metric: 'temperature', agg: 'avg', window: 'last_24h', shipments: [1002] })).value)).toBeCloseTo(4.9, 1);
  });

  it('returns nothing for another client\'s shipment', async () => {
    const owner = await ownerOf(1001);
    const other = owner === 1 ? 2 : 1;
    expect(Number((await metric(other, { metric: 'readings', window: 'last_7d', shipments: [1001] })).n)).toBe(0);
    expect(await runQuery(buildShipmentListQuery(normalizePlan({ shipments: [1001] }), anchor.epoch), other)).toHaveLength(0);
  });

  it('per-shipment violation counts equal independent SQL for the client', async () => {
    const rows = await runQuery(buildMetricQuery(normalizePlan({ task: 'metric', metric: 'violations', by: 'shipment', window: 'last_7d', limit: 200 }), anchor.epoch), 2);
    const truth = (await admin.query(`
      SELECT c.consignment_uid AS key, COUNT(*) FILTER (WHERE p.temperature > cd.temp_violation_max OR p.temperature < cd.temp_violation_min)::int AS value
      FROM device_pings p JOIN consignment_devices cd ON cd.device_uid = p.device_uid
      JOIN consignments c ON c.consignment_uid = cd.consignment_uid AND p.timestamp BETWEEN c.starttime AND c.endtime
      WHERE c.client_id = 2 AND p.timestamp > $1 AND p.timestamp <= $2 GROUP BY 1`, [anchor.epoch - 7 * 86400, anchor.epoch])).rows;
    const got = new Map(rows.map(r => [Number(r.key), Number(r.value)]));
    expect(got.size).toBe(truth.length);
    for (const t of truth) expect(got.get(Number(t.key))).toBe(t.value);
  });

  it('keeps only groups above / below a value', async () => {
    const rows = await runQuery(buildMetricQuery(normalizePlan({ task: 'metric', metric: 'battery', agg: 'latest', by: 'device', window: 'last_30d', op: 'lt', value: 60 }), anchor.epoch), 1);
    expect(rows.every(r => Number(r.value) < 60)).toBe(true);
  });

  it('lists only the client\'s shipments, devices, alerts and readings', async () => {
    const mine = (await admin.query('SELECT consignment_uid FROM consignments WHERE client_id = 3')).rows.map(r => Number(r.consignment_uid)).sort();
    const ships = await runQuery(buildShipmentListQuery(normalizePlan({ window: 'all', limit: 200 }), anchor.epoch), 3);
    expect(ships.map(s => Number(s.consignment_uid)).sort()).toEqual(mine);
    const devs = await runQuery(buildDeviceListQuery(normalizePlan({ limit: 200 }), anchor.epoch), 3);
    const myDevices = (await admin.query(`SELECT DISTINCT cd.device_uid FROM consignment_devices cd JOIN consignments c USING (consignment_uid) WHERE c.client_id = 3`)).rows.map(r => r.device_uid).sort();
    expect(devs.map(d => d.device_uid).sort()).toEqual(myDevices);
    const alerts = await runQuery(buildAlertListQuery(normalizePlan({ window: 'last_7d', limit: 200 }), anchor.epoch), 3);
    expect(alerts.every(a => mine.includes(Number(a.consignment_uid)))).toBe(true);
    const readings = await runQuery(buildReadingsQuery(normalizePlan({ window: 'last_24h', limit: 50 }), anchor.epoch), 3);
    expect(readings.every(r => mine.includes(Number(r.consignment_uid)))).toBe(true);
  });
});

describe('reports (per client)', () => {
  it('flags shipment 1001 with its time out of range', async () => {
    const text = await shipmentReport(1001, client(await ownerOf(1001)), true);
    expect(text).toContain('Shipment 1001 has a problem');
    expect(text).toContain('4 h 45 min');
    expect(text).toContain('11.2°C');
  });

  it("does not reveal another client's shipment or device", async () => {
    const owner = await ownerOf(1001);
    expect(await shipmentReport(1001, client(owner === 1 ? 2 : 1), false)).toContain("couldn't find shipment");
    const foreignDevice = (await admin.query(`
      SELECT d.device_uid FROM devices d WHERE NOT EXISTS (
        SELECT 1 FROM consignment_devices cd JOIN consignments c USING (consignment_uid) WHERE cd.device_uid = d.device_uid AND c.client_id = 3) LIMIT 1`)).rows[0]?.device_uid;
    if (foreignDevice) expect(await deviceReport(foreignDevice, client(3))).toContain("couldn't find");
  });

  it('compares the client\'s shipments', async () => {
    const owner = await ownerOf(1001);
    const other = (await admin.query('SELECT consignment_uid FROM consignments WHERE client_id = $1 AND consignment_uid <> 1001 ORDER BY 1 LIMIT 1', [owner])).rows[0].consignment_uid;
    const text = await compareShipments([1001, Number(other)], client(owner));
    expect(text).toContain('1001');
    expect(text).toMatch(/temperature limits/);
  });

  it('lists the client\'s devices with problems, and only theirs', async () => {
    const text = await fleetOverview(client(1));
    const myDevices = new Set((await admin.query(`SELECT DISTINCT cd.device_uid FROM consignment_devices cd JOIN consignments c USING (consignment_uid) WHERE c.client_id = 1`)).rows.map(r => r.device_uid));
    for (const d of text.match(/DEV-\d{3}/g) ?? []) expect(myDevices.has(d)).toBe(true);
  });
});
