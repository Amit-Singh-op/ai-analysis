import { Plan, normalizePlan } from './planner.js';
import { buildMetricQuery, buildShipmentListQuery, buildDeviceListQuery, runQuery, Row } from '../analytics/query-builder.js';
import { Anchor, HOUR, fmtTime, fmtAgo, fmtNum, fmtDuration, plural, prettyType, table, city } from './format.js';

/**
 * Ready-made answers the model can choose (task status / explain / compare): a health
 * report for one shipment or device, a side-by-side comparison, or a fleet overview.
 * They run on the same query builder as every other answer.
 */

const plan = (p: Partial<Plan>) => normalizePlan({ task: 'metric', ...p });
/** Who is asking: every query runs for this client only (from authentication, never from the model). */
export interface Scope { anchor: Anchor; clientId: number }

const one = async (p: Partial<Plan>, s: Scope): Promise<Row | undefined> => (await runQuery(buildMetricQuery(plan(p), s.anchor.epoch), s.clientId))[0];
const many = (p: Partial<Plan>, s: Scope): Promise<Row[]> => runQuery(buildMetricQuery(plan(p), s.anchor.epoch), s.clientId);

function alertSummary(rows: Row[]): string {
  const total = rows.reduce((s, r) => s + Number(r.value), 0);
  if (!total) return 'none';
  return `${total} (${rows.filter(r => Number(r.value)).map(r => `${prettyType(r.key)} ×${r.value}`).join(', ')})`;
}

/** "Is shipment 1001 ok?" / "why is 1001 flagged?" */
export async function shipmentReport(uid: number, scope: Scope, explain: boolean): Promise<string> {
  const { anchor } = scope;
  const s = { shipments: [uid], window: 'all' as const };
  const [info] = await runQuery(buildShipmentListQuery(plan(s), anchor.epoch), scope.clientId);
  if (!info) return `I couldn't find shipment **${uid}**. Try asking **"list shipments"** to see which ones exist.`;
  const [temp, out, alerts, last] = await Promise.all([
    one({ ...s, metric: 'temperature', agg: 'avg' }, scope),
    one({ ...s, metric: 'time_out_of_range' }, scope),
    many({ ...s, metric: 'alerts', agg: 'count', by: 'alert_type' }, scope),
    one({ ...s, metric: 'last_seen' }, scope)
  ]);
  const limits = info.limit_min !== null ? `${fmtNum(info.limit_min)} to ${fmtNum(info.limit_max)}°C` : 'not set';
  const minutesOut = Number(out?.value ?? 0);
  const worst = out?.worst_high ?? out?.worst_low;
  const critical = alerts.reduce((n, r) => n + Number(r.critical ?? 0), 0);

  const headline = minutesOut
    ? `🔴 **Shipment ${uid} has a problem: it was outside its temperature limits for ${fmtDuration(minutesOut)}** (worst ${fmtNum(worst)}°C, allowed ${limits}).`
    : critical
      ? `⚠️ **Shipment ${uid} stayed within its temperature limits, but has ${plural(critical, 'critical alert')}.**`
      : `✅ **Shipment ${uid} looks fine — temperature stayed within its limits.**`;

  const lines = [
    `- **Route:** ${city(info.origin)} → ${city(info.destination)} (${info.status})`,
    `- **Schedule:** ${fmtTime(info.starttime)} – ${fmtTime(info.endtime)}`,
    `- **Tracked by:** ${info.devices || 'no device'}`,
    `- **Temperature:** ${temp && Number(temp.n) ? `average **${fmtNum(temp.mean)}°C**, lowest ${fmtNum(temp.low)}°C, highest ${fmtNum(temp.high)}°C (allowed ${limits})` : 'no readings yet'}`,
    `- **Alerts:** ${alertSummary(alerts)}`,
    `- **Last reading:** ${last?.value ? `${fmtTime(Number(last.value))} (${fmtAgo(anchor.epoch - Number(last.value))})` : 'none yet'}`
  ];
  if (explain && !minutesOut && !critical) lines.unshift(`- Nothing is flagged: no temperature breach and no critical alerts.`);
  if (explain && info.devices) {
    const devs = await runQuery(buildDeviceListQuery(plan({ devices: String(info.devices).split(', ') }), anchor.epoch), scope.clientId);
    const silent = devs.filter(d => !d.last_seen || anchor.epoch - d.last_seen > 2 * HOUR);
    lines.push(`- **Tracker check:** ${silent.length ? `${silent.map(d => `${d.device_uid} stopped reporting ${d.last_seen ? fmtAgo(anchor.epoch - d.last_seen) : 'long ago'}`).join('; ')} — readings may be incomplete` : 'all trackers are reporting, so this is not a sensor fault'}.`);
  }
  return `${headline}\n\n${lines.join('\n')}`;
}

/** "Is DEV-004 working?" */
export async function deviceReport(device: string, scope: Scope): Promise<string> {
  const { anchor } = scope;
  const [info] = await runQuery(buildDeviceListQuery(plan({ devices: [device] }), anchor.epoch), scope.clientId);
  if (!info) return `I couldn't find **${device}**. Device IDs run from DEV-001 to DEV-100.`;
  const d = { devices: [device], window: 'last_24h' as const };
  const [out, alerts] = await Promise.all([
    one({ ...d, metric: 'violations' }, scope),
    many({ ...d, metric: 'alerts', agg: 'count', by: 'alert_type' }, scope)
  ]);
  const issues: string[] = [];
  const silentFor = info.last_seen ? anchor.epoch - info.last_seen : Infinity;
  if (silentFor > 2 * HOUR) issues.push(`it **stopped reporting** — last heard from ${info.last_seen ? fmtAgo(silentFor) : 'never'}`);
  if (info.battery !== null && info.battery <= 20) issues.push(`its **battery is low (${fmtNum(info.battery, 0)}%)**`);
  if (out && Number(out.value)) issues.push(`temperature went **outside its limits ${plural(Number(out.value), 'time')}** in the last 24 hours (worst ${fmtNum(out.worst_high ?? out.worst_low)}°C)`);
  const critical = alerts.reduce((n, r) => n + Number(r.critical ?? 0), 0);
  if (critical) issues.push(`**${plural(critical, 'critical alert')}** in the last 24 hours`);

  const headline = issues.length ? `⚠️ **${device} needs attention:** ${issues.join('; ')}.` : `✅ **${device} is working normally** — last reading ${fmtAgo(silentFor)}.`;
  return `${headline}\n\n` + [
    `- **Type:** ${prettyType(info.device_type)}`,
    `- **Latest reading:** ${info.last_seen ? `${fmtNum(info.temperature)}°C, ${fmtNum(info.humidity)}% humidity, battery ${fmtNum(info.battery, 0)}% (${fmtTime(info.last_seen)})` : 'none'}`,
    `- **Shipments:** ${info.shipments || 'none'}`,
    `- **Alerts (24 h):** ${alertSummary(alerts)}`
  ].join('\n');
}

/** "Compare 1001 and 1002" */
export async function compareShipments(uids: number[], scope: Scope): Promise<string> {
  const { anchor } = scope;
  const s = { shipments: uids, window: 'all' as const, by: 'shipment' as const, limit: 20 };
  const [infos, temps, outs, alerts] = await Promise.all([
    runQuery(buildShipmentListQuery(plan({ shipments: uids }), anchor.epoch), scope.clientId),
    many({ ...s, metric: 'temperature', agg: 'avg' }, scope),
    many({ ...s, metric: 'time_out_of_range' }, scope),
    many({ ...s, metric: 'alerts', agg: 'count' }, scope)
  ]);
  if (!infos.length) return `I couldn't find shipments ${uids.join(', ')}.`;
  const by = (rows: Row[], uid: number) => rows.find(r => Number(r.key) === Number(uid));
  const rows = infos.map(i => {
    const t = by(temps, i.consignment_uid), o = by(outs, i.consignment_uid), a = by(alerts, i.consignment_uid);
    const mins = Number(o?.value ?? 0);
    return [`**${i.consignment_uid}**`, `${city(i.origin)} → ${city(i.destination)}`, t ? `**${fmtNum(t.mean)}°C**` : '—',
      t ? `${fmtNum(t.low)} – ${fmtNum(t.high)}°C` : '—', `${fmtNum(i.limit_min)} to ${fmtNum(i.limit_max)}°C`,
      mins ? `🔴 ${fmtDuration(mins)}` : '✅ none', String(a?.value ?? 0)];
  });
  const bad = infos.filter(i => Number(by(outs, i.consignment_uid)?.value ?? 0)).map(i => i.consignment_uid);
  const headline = bad.length === 0 ? `**All ${infos.length} shipments stayed within their temperature limits.**`
    : bad.length === infos.length ? `**All ${infos.length} shipments went outside their temperature limits.**`
      : `**${bad.join(', ')} went outside ${bad.length === 1 ? 'its' : 'their'} temperature limits; the others stayed safe.**`;
  return `${headline}\n\n` + table(['Shipment', 'Route', 'Average', 'Range', 'Allowed', 'Out of range', 'Alerts'], rows);
}

/** "Are there any problems right now?" */
export async function fleetOverview(scope: Scope): Promise<string> {
  const { anchor } = scope;
  const day = { window: 'last_24h' as const, by: 'device' as const, limit: 100 };
  const [out, alerts, seen, battery] = await Promise.all([
    many({ ...day, metric: 'violations', op: 'gt', value: 0 }, scope),
    many({ ...day, metric: 'alerts', agg: 'count', alert_level: 'critical' }, scope),
    many({ by: 'device', metric: 'last_seen', window: 'all', limit: 100, sort: 'asc', op: 'lt', value: anchor.epoch - 2 * HOUR }, scope),
    many({ by: 'device', metric: 'battery', agg: 'latest', window: 'all', limit: 100, op: 'lt', value: 20.0001, sort: 'asc' }, scope)
  ]);
  const problems = new Map<string, string[]>();
  const add = (d: string, why: string) => problems.set(d, [...(problems.get(d) ?? []), why]);
  for (const r of seen) add(r.key, `stopped reporting ${fmtAgo(anchor.epoch - Number(r.value))}`);
  for (const r of battery) add(r.key, `battery low (${fmtNum(r.value, 0)}%)`);
  for (const r of out) add(r.key, `temperature outside its limits ${plural(Number(r.value), 'time')} (worst ${fmtNum(r.worst_high ?? r.worst_low)}°C)`);
  for (const r of alerts) if (!out.some(o => o.key === r.key)) add(r.key, `${plural(Number(r.value), 'critical alert')}`);
  if (!problems.size) return `✅ **No problems in the last 24 hours.** Every device is reporting, has battery, and stayed within its limits.`;
  const rows = [...problems.entries()].sort((a, b) => b[1].length - a[1].length).map(([d, why]) => [`**${d}**`, why.join('; ')]);
  return `**${plural(problems.size, 'device has a problem', 'devices have problems')} in the last 24 hours:**\n\n` + table(['Device', 'Problem'], rows);
}
