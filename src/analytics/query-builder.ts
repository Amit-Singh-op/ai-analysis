import { roPool } from '../db/pool.js';
import { config } from '../config.js';
import type { Plan } from '../ai/planner.js';

/**
 * Turns a query plan into one parameterized SQL query over the tenant-scoped views
 * (database/tenancy.sql). Security rules (spec §7):
 *   - identifiers come only from the fixed maps below; every value is a bind parameter;
 *   - only v_* views are queried, as analyst_ro, with app.client_id set per transaction,
 *     so the plan (and the model) can never choose or widen the client;
 *   - readings always have a time bound, capped at MAX_WINDOW_DAYS; result rows are capped.
 * Time windows are relative to the anchor (the newest reading).
 */

const HOUR = 3600;
const DAY = 86400;
/** Readings arrive every 5 minutes, so each out-of-range reading is ~5 minutes out of range. */
export const READING_MINUTES = 5;

export const WINDOW_SECONDS: Record<Plan['window'], number> = {
  last_1h: HOUR, last_6h: 6 * HOUR, last_24h: DAY, yesterday: DAY, last_48h: 2 * DAY,
  last_7d: 7 * DAY, last_30d: 30 * DAY, all: Number.POSITIVE_INFINITY
};

export function windowRange(window: Plan['window'], anchor: number, shift = 0): { from: number; to: number } {
  const len = Math.min(WINDOW_SECONDS[window], config.MAX_WINDOW_DAYS * DAY);
  const to = (window === 'yesterday' ? anchor - DAY : anchor) - shift * len;
  return { from: to - len, to };
}

const SENSOR_COLUMNS: Partial<Record<Plan['metric'], string>> = {
  temperature: 'p.temperature', humidity: 'p.humidity', battery: 'p.battery', light: 'p.light', acceleration: 'p.acceleration'
};
const DEVICE_TYPE_VALUES: Record<string, string> = {
  cold_chain: 'COLD_CHAIN_LOGGER', dry_ice: 'DRY_ICE_MONITOR', multi_sensor: 'MULTI_SENSOR_PRO', standard: 'STANDARD_TELEMETRY'
};
const ALERT_TYPE_PREFIX: Record<string, string> = {
  temperature: 'TEMPERATURE%', humidity: 'HUMIDITY%', shock: 'SHOCK%', battery: 'BATTERY%', status: 'STATUS%'
};
const STATUS_SQL = (anchor: string) =>
  `CASE WHEN c.starttime > ${anchor} THEN 'not started' WHEN c.endtime <= ${anchor} THEN 'delivered' ELSE 'in transit' END`;

export interface BuiltQuery { text: string; values: any[] }
export type Row = Record<string, any>;

class Params {
  values: any[] = [];
  add(v: any): string { this.values.push(v); return `$${this.values.length}`; }
  /** Bound on first use: Postgres rejects parameters a query never references. */
  lazy(v: any, cast: string): () => string {
    let ref: string | undefined;
    return () => (ref ??= `${this.add(v)}::${cast}`);
  }
}

const rowCap = (limit: number | null, fallback: number) => Math.min(limit ?? fallback, config.MAX_ROWS);

/** Filters on the client's consignments `c` (also used to scope readings and alerts). */
function shipmentFilters(plan: Plan, pr: Params, anchorRef: () => string, where: string[]) {
  if (plan.shipments.length) where.push(`c.consignment_uid = ANY(${pr.add(plan.shipments)}::bigint[])`);
  if (plan.origin) where.push(`c.origin ILIKE ${pr.add(`%${plan.origin}%`)}`);
  if (plan.destination) where.push(`c.destination ILIKE ${pr.add(`%${plan.destination}%`)}`);
  if (plan.status !== 'any') where.push(`${STATUS_SQL(anchorRef())} = ${pr.add(plan.status.replace('_', ' '))}`);
}

function groupKey(by: Plan['by'], t: string, dev: string): string {
  switch (by) {
    case 'device': return dev;
    case 'shipment': return 'c.consignment_uid';
    case 'device_type': return 'd.device_type';
    case 'origin': return 'c.origin';
    case 'destination': return 'c.destination';
    case 'route': return `c.origin || ' → ' || c.destination`;
    case 'hour': return `(${t} / ${HOUR}) * ${HOUR}`;
    case 'day': return `(${t} / ${DAY}) * ${DAY}`;
    case 'alert_type': return 'e.type';
    default: return 'NULL';
  }
}

const isTimeGroup = (by: Plan['by']) => by === 'hour' || by === 'day';

/** Numbers: "average temperature by hour for 1002", "alerts per shipment", "battery below 20". */
export function buildMetricQuery(plan: Plan, anchor: number, shift = 0): BuiltQuery {
  const pr = new Params();
  const { from, to } = windowRange(plan.window, anchor, shift);
  const anchorRef = pr.lazy(anchor, 'int');
  const where: string[] = [];
  const isAlert = plan.metric === 'alerts';
  const t = isAlert ? 'e.timestamp' : 'p.timestamp';
  const dev = isAlert ? 'e.device_uid' : 'p.device_uid';
  const by = !isAlert && plan.by === 'alert_type' ? 'none' : plan.by;
  const key = groupKey(by, t, dev);

  let fromSql: string;
  let value: string;
  let extra = '';

  if (isAlert) {
    fromSql = 'v_events e JOIN v_consignments c ON c.consignment_uid = e.consignment_uid';
    if (plan.devices.length) where.push(`e.device_uid = ANY(${pr.add(plan.devices)}::text[])`);
    if (plan.alert_level !== 'any') where.push(`e.level = ${pr.add(plan.alert_level.toUpperCase())}`);
    else where.push(`e.level IN ('CRITICAL', 'WARNING')`);
    if (plan.alert_type !== 'any') where.push(`e.type LIKE ${pr.add(ALERT_TYPE_PREFIX[plan.alert_type])}`);
    value = 'COUNT(*)';
    extra = `, COUNT(*) FILTER (WHERE e.level = 'CRITICAL') AS critical, MODE() WITHIN GROUP (ORDER BY e.type) AS top_type`;
    shipmentFilters(plan, pr, anchorRef, where);
  } else {
    // A reading belongs to a consignment while its device is on it; the view already
    // applies that window and the client, so p.consignment_uid / origin / thresholds are the shipment's.
    fromSql = 'v_pings_enriched p';
    if (plan.status !== 'any') fromSql += ' JOIN v_consignments c ON c.consignment_uid = p.consignment_uid';
    const cplan = { ...plan, status: 'any' as const };
    const w: string[] = [];
    shipmentFilters(cplan, pr, anchorRef, w);
    where.push(...w.map(x => x.replace(/\bc\./g, 'p.')));
    if (plan.status !== 'any') shipmentFilters({ ...plan, shipments: [], origin: '', destination: '' }, pr, anchorRef, where);
    if (plan.devices.length) where.push(`p.device_uid = ANY(${pr.add(plan.devices)}::text[])`);
    const col = SENSOR_COLUMNS[plan.metric];
    if (plan.metric === 'violations' || plan.metric === 'time_out_of_range') {
      value = plan.metric === 'violations' ? `COUNT(*) FILTER (WHERE p.is_violation)` : `COUNT(*) FILTER (WHERE p.is_violation) * ${READING_MINUTES}`;
      extra = `, MAX(p.temperature) FILTER (WHERE p.is_violation AND p.temperature > p.temp_violation_max) AS worst_high,
        MIN(p.temperature) FILTER (WHERE p.is_violation AND p.temperature < p.temp_violation_min) AS worst_low,
        MIN(p.temp_violation_min) AS limit_min, MAX(p.temp_violation_max) AS limit_max`;
    } else if (plan.metric === 'last_seen') {
      value = 'MAX(p.timestamp)';
    } else if (plan.metric === 'readings' || !col) {
      value = 'COUNT(*)';
    } else {
      where.push(`${col} IS NOT NULL`);
      const agg = plan.agg === 'none' || plan.agg === 'count' ? 'avg' : plan.agg;
      value = agg === 'latest' ? `(ARRAY_AGG(${col} ORDER BY p.timestamp DESC))[1]` : `${agg.toUpperCase()}(${col})`;
      // Context a reader wants next to the number: range, and when the extreme happened.
      extra = `, MIN(${col}) AS low, MAX(${col}) AS high, AVG(${col}) AS mean`;
      if (agg === 'max' || agg === 'min') {
        extra += `, (ARRAY_AGG(p.timestamp ORDER BY ${col} ${agg === 'max' ? 'DESC' : 'ASC'}))[1] AS at,
          (ARRAY_AGG(p.device_uid ORDER BY ${col} ${agg === 'max' ? 'DESC' : 'ASC'}))[1] AS at_device`;
      }
      if (agg === 'latest') extra += `, MAX(p.timestamp) AS at`;
    }
  }

  // device_type: readings carry it; alerts get it from the client's device list
  const typeCol = isAlert ? 'd.device_type' : 'p.device_type';
  if (isAlert && (plan.device_type !== 'any' || by === 'device_type')) {
    fromSql += ' JOIN (SELECT DISTINCT device_uid, device_type FROM v_consignment_devices) d ON d.device_uid = e.device_uid';
  }
  if (plan.device_type !== 'any') where.push(`${typeCol} = ${pr.add(DEVICE_TYPE_VALUES[plan.device_type])}`);
  const finalKey = by === 'device_type' ? typeCol : !isAlert ? key.replace(/\bc\./g, 'p.') : key;

  // Readings always have a time bound (capped); "last report" looks back over the whole cap.
  where.push(`${t} > ${pr.add(from)} AND ${t} <= ${pr.add(to)}`);

  const having = plan.op !== 'none' && plan.value !== null ? `WHERE value ${plan.op === 'gt' ? '>' : '<'} ${pr.add(plan.value)}` : '';
  const order = isTimeGroup(by) ? 'key ASC' : `value ${plan.sort === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, key`;
  const limit = rowCap(plan.limit, isTimeGroup(by) ? config.MAX_ROWS : by === 'none' ? 1 : 100);
  const text = `
    SELECT *, COUNT(*) OVER () AS total_groups FROM (
      SELECT ${finalKey} AS key, ${value} AS value, COUNT(*) AS n ${extra}
      FROM ${fromSql}
      WHERE ${where.join(' AND ')}
      ${by === 'none' ? '' : `GROUP BY ${finalKey}`}
    ) g
    ${having}
    ORDER BY ${order}
    LIMIT ${pr.add(limit)}`;
  return { text, values: pr.values };
}

export function buildShipmentListQuery(plan: Plan, anchor: number): BuiltQuery {
  const pr = new Params();
  const anchorRef = pr.lazy(anchor, 'int');
  const where: string[] = [];
  shipmentFilters(plan, pr, anchorRef, where);
  if (plan.devices.length) where.push(`EXISTS (SELECT 1 FROM v_consignment_devices x WHERE x.consignment_uid = c.consignment_uid AND x.device_uid = ANY(${pr.add(plan.devices)}::text[]))`);
  if (plan.device_type !== 'any') {
    where.push(`EXISTS (SELECT 1 FROM v_consignment_devices x WHERE x.consignment_uid = c.consignment_uid AND x.device_type = ${pr.add(DEVICE_TYPE_VALUES[plan.device_type])})`);
  }
  return {
    text: `
      SELECT c.consignment_uid, c.origin, c.destination, c.starttime, c.endtime, ${STATUS_SQL(anchorRef())} AS status,
        COALESCE(STRING_AGG(cd.device_uid, ', ' ORDER BY cd.device_uid), '') AS devices,
        MIN(cd.temp_violation_min) AS limit_min, MAX(cd.temp_violation_max) AS limit_max,
        COUNT(*) OVER () AS total_groups
      FROM v_consignments c LEFT JOIN v_consignment_devices cd ON cd.consignment_uid = c.consignment_uid
      WHERE ${where.join(' AND ') || 'TRUE'}
      GROUP BY c.consignment_uid, c.origin, c.destination, c.starttime, c.endtime
      ORDER BY c.starttime ${plan.sort === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ${pr.add(rowCap(plan.limit, 100))}`,
    values: pr.values
  };
}

/** The client's devices (those on its consignments), with their latest reading on the client's shipments. */
export function buildDeviceListQuery(plan: Plan, anchor: number): BuiltQuery {
  const pr = new Params();
  const anchorRef = pr.lazy(anchor, 'int');
  const where: string[] = [];
  if (plan.devices.length) where.push(`d.device_uid = ANY(${pr.add(plan.devices)}::text[])`);
  if (plan.device_type !== 'any') where.push(`d.device_type = ${pr.add(DEVICE_TYPE_VALUES[plan.device_type])}`);
  if (plan.shipments.length || plan.origin || plan.destination || plan.status !== 'any') {
    const sw: string[] = [];
    shipmentFilters(plan, pr, anchorRef, sw);
    where.push(`EXISTS (SELECT 1 FROM v_consignment_devices cd JOIN v_consignments c ON c.consignment_uid = cd.consignment_uid WHERE cd.device_uid = d.device_uid AND ${sw.join(' AND ')})`);
  }
  const from = anchor - config.MAX_WINDOW_DAYS * DAY;
  return {
    text: `
      SELECT d.device_uid, d.device_type, l.timestamp AS last_seen, l.temperature, l.humidity, l.battery, d.shipments,
        COUNT(*) OVER () AS total_groups
      FROM (SELECT device_uid, MIN(device_type) AS device_type, STRING_AGG(consignment_uid::text, ', ' ORDER BY consignment_uid) AS shipments
            FROM v_consignment_devices GROUP BY device_uid) d
      LEFT JOIN LATERAL (
        SELECT p.timestamp, p.temperature, p.humidity, p.battery FROM v_pings_enriched p
        WHERE p.device_uid = d.device_uid AND p.timestamp > ${pr.add(from)} AND p.timestamp <= ${anchorRef()}
        ORDER BY p.timestamp DESC LIMIT 1) l ON TRUE
      WHERE ${where.join(' AND ') || 'TRUE'}
      ORDER BY d.device_uid
      LIMIT ${pr.add(rowCap(plan.limit, 100))}`,
    values: pr.values
  };
}

export function buildAlertListQuery(plan: Plan, anchor: number): BuiltQuery {
  const pr = new Params();
  const anchorRef = pr.lazy(anchor, 'int');
  const { from, to } = windowRange(plan.window, anchor);
  const where = [`e.timestamp > ${pr.add(from)}`, `e.timestamp <= ${pr.add(to)}`];
  if (plan.devices.length) where.push(`e.device_uid = ANY(${pr.add(plan.devices)}::text[])`);
  if (plan.alert_level !== 'any') where.push(`e.level = ${pr.add(plan.alert_level.toUpperCase())}`);
  else where.push(`e.level IN ('CRITICAL', 'WARNING')`);
  if (plan.alert_type !== 'any') where.push(`e.type LIKE ${pr.add(ALERT_TYPE_PREFIX[plan.alert_type])}`);
  shipmentFilters(plan, pr, anchorRef, where);
  return {
    text: `
      SELECT e.timestamp, e.device_uid, e.consignment_uid, e.type, e.level, COUNT(*) OVER () AS total_groups
      FROM v_events e JOIN v_consignments c ON c.consignment_uid = e.consignment_uid
      WHERE ${where.join(' AND ')}
      ORDER BY e.timestamp ${plan.sort === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ${pr.add(rowCap(plan.limit, 20))}`,
    values: pr.values
  };
}

export function buildReadingsQuery(plan: Plan, anchor: number): BuiltQuery {
  const pr = new Params();
  const anchorRef = pr.lazy(anchor, 'int');
  const { from, to } = windowRange(plan.window, anchor);
  const where = [`p.timestamp > ${pr.add(from)}`, `p.timestamp <= ${pr.add(to)}`];
  let fromSql = 'v_pings_enriched p';
  if (plan.devices.length) where.push(`p.device_uid = ANY(${pr.add(plan.devices)}::text[])`);
  if (plan.shipments.length || plan.origin || plan.destination || plan.status !== 'any') {
    fromSql += ' JOIN v_consignments c ON c.consignment_uid = p.consignment_uid';
    shipmentFilters(plan, pr, anchorRef, where);
  }
  return {
    text: `
      SELECT p.timestamp, p.device_uid, p.consignment_uid, p.temperature, p.humidity, p.battery, p.light, p.acceleration, COUNT(*) OVER () AS total_groups
      FROM ${fromSql}
      WHERE ${where.join(' AND ')}
      ORDER BY p.timestamp ${plan.sort === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ${pr.add(rowCap(plan.limit, 10))}`,
    values: pr.values
  };
}

/**
 * Runs a compiled query for one client: analyst_ro, read-only transaction, app.client_id
 * set for this transaction only (cleared on COMMIT/ROLLBACK, so pooled connections never
 * carry a client over), statement timeout. `clientId` comes from authentication, never from a plan.
 */
export async function runQuery(q: BuiltQuery, clientId: number): Promise<Row[]> {
  if (!Number.isSafeInteger(clientId) || clientId <= 0) throw new Error('A valid client is required to run a query');
  const client = await roPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('app.client_id', $1, true), set_config('statement_timeout', $2, true)`,
      [String(clientId), `${config.STATEMENT_TIMEOUT_MS}ms`]);
    const res = await client.query(q.text, q.values);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
