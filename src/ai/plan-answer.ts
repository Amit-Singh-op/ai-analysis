import { Plan, planQuestion, PlannerContext, normalizePlan } from './planner.js';
import {
  buildMetricQuery, buildShipmentListQuery, buildDeviceListQuery, buildAlertListQuery, buildReadingsQuery, runQuery, Row
} from '../analytics/query-builder.js';
import { Anchor, ChatContext, fmtTime, fmtAgo, fmtNum, plural, table, prettyType, fmtDuration } from './format.js';
import { shipmentReport, deviceReport, compareShipments, fleetOverview, Scope } from './reports.js';

/**
 * Answers a question: the local LLM plans it, the query builder runs the plan, and this
 * file writes the answer from the rows. Every number comes from the database; the model
 * only decides what to look up.
 */

const UNITS: Partial<Record<Plan['metric'], string>> = {
  temperature: '°C', humidity: '%', battery: '%', light: ' lux', acceleration: ' milli-g'
};
const METRIC_NAMES: Record<Plan['metric'], string> = {
  temperature: 'temperature', humidity: 'humidity', battery: 'battery', light: 'light', acceleration: 'acceleration',
  readings: 'readings', alerts: 'alerts', violations: 'readings outside the temperature limits',
  time_out_of_range: 'time outside the temperature limits', last_seen: 'last report', none: ''
};
const AGG_NAMES: Record<Plan['agg'], string> = { avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Number of', latest: 'Latest', none: 'Average' };
const WINDOW_NAMES: Record<Plan['window'], string> = {
  last_1h: 'in the last hour', last_6h: 'in the last 6 hours', last_24h: 'in the last 24 hours', yesterday: 'yesterday',
  last_48h: 'in the last 2 days', last_7d: 'in the last 7 days', last_30d: 'in the last 30 days', all: 'across all data'
};
const BY_NAMES: Record<Plan['by'], string> = {
  none: '', device: 'Device', shipment: 'Shipment', device_type: 'Device type', origin: 'Origin', destination: 'Destination',
  route: 'Route', hour: 'Hour', day: 'Day', alert_type: 'Alert type'
};

const isCount = (m: Plan['metric']) => m === 'readings' || m === 'alerts' || m === 'violations';

function fmtValue(plan: Plan, v: any): string {
  if (v === null || v === undefined) return '—';
  if (plan.metric === 'time_out_of_range') return Number(v) ? fmtDuration(Number(v)) : 'none';
  if (plan.metric === 'last_seen') return fmtTime(Number(v));
  if (isCount(plan.metric)) return Number(v).toLocaleString();
  const digits = plan.metric === 'battery' || plan.metric === 'light' || plan.metric === 'acceleration' ? 0 : 1;
  return `${fmtNum(Number(v), digits)}${UNITS[plan.metric] ?? ''}`;
}

function fmtKey(plan: Plan, k: any): string {
  if (k === null || k === undefined) return '—';
  if (plan.by === 'hour') return fmtTime(Number(k));
  if (plan.by === 'day') return new Date(Number(k) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
  if (plan.by === 'device_type' || plan.by === 'alert_type') return prettyType(String(k));
  if (plan.by === 'origin' || plan.by === 'destination') return String(k).split(',')[0];
  if (plan.by === 'route') return String(k).replace(/,[^→]*(?=\s→)|,[^→]*$/g, '');
  return String(k);
}

function metricTitle(plan: Plan): string {
  if (plan.metric === 'time_out_of_range') return 'Time outside the temperature limits';
  if (plan.metric === 'last_seen') return 'Last report';
  if (isCount(plan.metric)) {
    const lvl = plan.alert_level !== 'any' ? `${plan.alert_level} ` : '';
    const type = plan.alert_type !== 'any' ? `${plan.alert_type} ` : '';
    return plan.metric === 'alerts' ? `Number of ${lvl}${type}alerts` : `Number of ${METRIC_NAMES[plan.metric]}`;
  }
  return `${AGG_NAMES[plan.agg]} ${METRIC_NAMES[plan.metric]}`;
}

/** "shipment 1002 · cold chain devices · from frankfurt": what the numbers are scoped to. */
function scopeText(plan: Plan): string {
  const parts: string[] = [];
  if (plan.shipments.length) parts.push(`${plan.shipments.length > 1 ? 'shipments' : 'shipment'} ${plan.shipments.join(', ')}`);
  if (plan.devices.length) parts.push(plan.devices.join(', '));
  if (plan.device_type !== 'any') parts.push(`${plan.device_type.replace('_', ' ')} devices`);
  if (plan.origin) parts.push(`from ${plan.origin}`);
  if (plan.destination) parts.push(`to ${plan.destination}`);
  if (plan.status !== 'any') parts.push(plan.status.replace('_', ' '));
  return parts.join(' · ');
}


function trendLine(plan: Plan, rows: Row[]): string {
  const vals = rows.map(r => Number(r.value)).filter(v => !Number.isNaN(v));
  if (vals.length < 3 || plan.metric === 'last_seen') return '';
  const q = Math.max(1, Math.ceil(vals.length / 4));
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const delta = avg(vals.slice(-q)) - avg(vals.slice(0, q));
  const peak = rows.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
  const low = rows.reduce((a, b) => (Number(b.value) < Number(a.value) ? b : a));
  const flat = Math.abs(delta) < (isCount(plan.metric) ? Math.max(1, avg(vals) * 0.1) : 0.5);
  const dir = flat ? 'steady' : delta > 0 ? `rising (${fmtValue(plan, Math.abs(delta)).replace(/^/, '+')})` : `falling (−${fmtValue(plan, Math.abs(delta))})`;
  return `Trend: **${dir}**. Peak **${fmtValue(plan, peak.value)}** at ${fmtKey(plan, peak.key)}; low **${fmtValue(plan, low.value)}** at ${fmtKey(plan, low.key)}.\n\n`;
}

function extraColumns(plan: Plan): Array<[string, (r: Row) => string]> {
  if (plan.metric === 'alerts') return [['Critical', r => Number(r.critical ?? 0).toLocaleString()], ['Most common', r => (r.top_type ? prettyType(r.top_type) : '—')]];
  if (plan.metric === 'violations' || plan.metric === 'time_out_of_range') {
    return [['Worst', r => (r.worst_high !== null && r.worst_high !== undefined ? `${fmtNum(r.worst_high)}°C` : r.worst_low !== null && r.worst_low !== undefined ? `${fmtNum(r.worst_low)}°C` : '—')],
      ['Allowed', r => (r.limit_min !== null && r.limit_min !== undefined ? `${fmtNum(r.limit_min)} to ${fmtNum(r.limit_max)}°C` : '—')]];
  }
  if (plan.agg === 'max' || plan.agg === 'min') return [['When', r => fmtTime(Number(r.at))], ...(plan.by === 'device' ? [] : [['Device', (r: Row) => r.at_device ?? '—'] as [string, (r: Row) => string]])];
  if (plan.agg === 'latest') return [['As of', r => fmtTime(Number(r.at))]];
  if (UNITS[plan.metric] && plan.agg === 'avg') return [['Range', r => `${fmtValue(plan, r.low)} – ${fmtValue(plan, r.high)}`]];
  return [];
}

function renderMetric(plan: Plan, rows: Row[], prevRows: Row[] | null, anchor: Anchor): string {
  const title = metricTitle(plan);
  const scope = scopeText(plan);
  const when = plan.metric === 'last_seen' ? '' : ` ${WINDOW_NAMES[plan.window]}`;
  const lead = `${title}${scope ? ` for ${scope}` : ''}${when}`;
  const n = (r: Row) => Number(r.n ?? 0);

  if (!rows.length || (plan.by === 'none' && n(rows[0]) === 0)) {
    return `**No matching data** for ${lead.charAt(0).toLowerCase() + lead.slice(1)}.${plan.op !== 'none' ? ` Nothing is ${plan.op === 'gt' ? 'above' : 'below'} ${plan.value}.` : ''}`;
  }

  if (plan.by === 'none') {
    const r = rows[0];
    let text = `**${lead}: ${fmtValue(plan, r.value)}**`;
    if (plan.metric === 'last_seen') text += ` (${fmtAgo(anchor.epoch - Number(r.value))})`;
    const ctx: string[] = [];
    if (UNITS[plan.metric]) {
      if (plan.agg !== 'min' && plan.agg !== 'max') ctx.push(`lowest ${fmtValue(plan, r.low)}, highest ${fmtValue(plan, r.high)}`);
      else ctx.push(`average ${fmtValue(plan, r.mean)}`);
      if (r.at && (plan.agg === 'max' || plan.agg === 'min')) ctx.push(`on ${r.at_device} at ${fmtTime(Number(r.at))}`);
    }
    if (plan.metric === 'alerts' && Number(r.value)) ctx.push(`${Number(r.critical).toLocaleString()} critical, mostly ${prettyType(r.top_type ?? '').toLowerCase()}`);
    if ((plan.metric === 'violations' || plan.metric === 'time_out_of_range') && Number(r.value)) {
      const worst = r.worst_high ?? r.worst_low;
      ctx.push(`worst ${fmtNum(worst)}°C, allowed ${fmtNum(r.limit_min)} to ${fmtNum(r.limit_max)}°C`);
    }
    if (plan.metric !== 'last_seen' && plan.metric !== 'readings') ctx.push(`from ${n(r).toLocaleString()} ${plan.metric === 'alerts' ? 'alerts' : 'readings'}`);
    text += ctx.length ? ` (${ctx.join('; ')}).` : '.';
    if (prevRows) {
      const p = prevRows[0];
      const cur = Number(r.value), prev = p ? Number(p.value) : NaN;
      if (!p || Number.isNaN(prev) || n(p) === 0) text += `\n\nNo data for the period before to compare with.`;
      else {
        const diff = cur - prev;
        const pct = prev ? ` (${diff >= 0 ? '+' : ''}${Math.round((diff / prev) * 100)}%)` : '';
        text += `\n\nThe period before: **${fmtValue(plan, prev)}** — ${diff === 0 ? 'no change' : `${diff > 0 ? 'up' : 'down'} ${fmtValue(plan, Math.abs(diff))}${pct}`}.`;
      }
    }
    return text;
  }

  const total = Number(rows[0].total_groups ?? rows.length);
  const timeSeries = plan.by === 'hour' || plan.by === 'day';
  const best = rows[0];
  let text = timeSeries
    ? `**${lead}, per ${plan.by}** (${plural(rows.length, plan.by)}):\n\n${trendLine(plan, rows)}`
    : `**${lead}, by ${BY_NAMES[plan.by].toLowerCase()}** — ${plan.op !== 'none' ? `${plural(total, 'match', 'matches')}; ` : ''}${plan.sort === 'asc' ? 'lowest' : 'highest'}: **${fmtKey(plan, best.key)}** (${fmtValue(plan, best.value)}).\n\n`;

  const prevByKey = new Map((prevRows ?? []).map(r => [String(r.key), r]));
  const extras = extraColumns(plan);
  const headers = [BY_NAMES[plan.by], title.replace(/^Number of /, '').replace(/^\w/, c => c.toUpperCase()),
    ...(prevRows ? ['Period before', 'Change'] : []), ...extras.map(e => e[0]),
    ...(plan.metric === 'readings' || plan.metric === 'last_seen' ? [] : [plan.metric === 'alerts' ? 'Alerts' : 'Readings'])];
  const body = rows.map(r => {
    const prev = prevByKey.get(String(r.key));
    const diff = prev ? Number(r.value) - Number(prev.value) : null;
    return [
      `**${fmtKey(plan, r.key)}**`,
      fmtValue(plan, r.value),
      ...(prevRows ? [prev ? fmtValue(plan, prev.value) : '—', diff === null ? '—' : diff === 0 ? '0' : `${diff > 0 ? '+' : '−'}${fmtValue(plan, Math.abs(diff))}`] : []),
      ...extras.map(e => e[1](r)),
      ...(plan.metric === 'readings' || plan.metric === 'last_seen' ? [] : [n(r).toLocaleString()])
    ];
  });
  text += table(headers, body);
  if (!timeSeries && total > rows.length) text += `\n_Showing ${rows.length} of ${total}._`;
  return text;
}

function renderShipments(plan: Plan, rows: Row[]): string {
  if (!rows.length) return `**No shipments match** ${scopeText(plan) || 'that'}.`;
  const total = Number(rows[0].total_groups);
  return `**${plural(total, 'shipment')}${scopeText(plan) ? ` (${scopeText(plan)})` : ''}:**\n\n` + table(
    ['Shipment', 'Route', 'Status', 'Departs', 'Arrives', 'Devices', 'Allowed'],
    rows.map(r => [`**${r.consignment_uid}**`, `${r.origin.split(',')[0]} → ${r.destination.split(',')[0]}`, r.status,
      fmtTime(r.starttime), fmtTime(r.endtime), r.devices || '—', r.limit_min !== null ? `${fmtNum(r.limit_min)} to ${fmtNum(r.limit_max)}°C` : '—'])
  );
}

function renderDevices(plan: Plan, rows: Row[], anchor: Anchor): string {
  if (!rows.length) return `**No devices match** ${scopeText(plan) || 'that'}.`;
  const total = Number(rows[0].total_groups);
  return `**${plural(total, 'device')}${scopeText(plan) ? ` (${scopeText(plan)})` : ''}:**\n\n` + table(
    ['Device', 'Type', 'Last report', 'Temperature', 'Humidity', 'Battery', 'Shipments'],
    rows.map(r => [`**${r.device_uid}**`, prettyType(r.device_type), r.last_seen ? fmtAgo(anchor.epoch - r.last_seen) : 'never',
      r.temperature !== null ? `${fmtNum(r.temperature)}°C` : '—', r.humidity !== null ? `${fmtNum(r.humidity)}%` : '—',
      r.battery !== null ? `${fmtNum(r.battery, 0)}%` : '—', r.shipments || '—'])
  );
}

function alertDetail(r: Row): string {
  try {
    const d = JSON.parse(r.data ?? '{}');
    if (d.recorded_temp !== undefined) return `${fmtNum(d.recorded_temp)}°C${d.threshold_max !== undefined ? ` (limit ${d.threshold_max}°C)` : ''}`;
    return Object.entries(d).slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ') || '—';
  } catch { return '—'; }
}

function renderAlerts(plan: Plan, rows: Row[]): string {
  const scope = [scopeText(plan), WINDOW_NAMES[plan.window]].filter(Boolean).join(', ');
  if (!rows.length) return `✅ **No ${plan.alert_level !== 'any' ? `${plan.alert_level} ` : ''}${plan.alert_type !== 'any' ? `${plan.alert_type} ` : ''}alerts** (${scope}).`;
  const total = Number(rows[0].total_groups);
  return `**${plural(total, 'alert')}** (${scope})${total > rows.length ? `, ${plan.sort === 'asc' ? 'oldest' : 'latest'} ${rows.length}` : ''}:\n\n` + table(
    ['Time', 'Device', 'Shipment', 'Alert', 'Level', 'Detail'],
    rows.map(r => [fmtTime(r.timestamp), r.device_uid, String(r.consignment_uid), prettyType(r.type), r.level.toLowerCase(), alertDetail(r)])
  );
}

function renderReadings(plan: Plan, rows: Row[]): string {
  if (!rows.length) return `**No readings** for ${scopeText(plan) || 'that'} ${WINDOW_NAMES[plan.window]}.`;
  const total = Number(rows[0].total_groups);
  return `**${plan.sort === 'asc' ? 'First' : 'Latest'} ${rows.length} of ${total.toLocaleString()} readings** (${[scopeText(plan), WINDOW_NAMES[plan.window]].filter(Boolean).join(', ')}):\n\n` + table(
    ['Time', 'Device', 'Temperature', 'Humidity', 'Battery', 'Light', 'Acceleration'],
    rows.map(r => [fmtTime(r.timestamp), r.device_uid, `${fmtNum(r.temperature)}°C`, `${fmtNum(r.humidity)}%`, `${fmtNum(r.battery, 0)}%`, `${fmtNum(r.light, 0)} lux`, `${fmtNum(r.acceleration, 0)} milli-g`])
  );
}

const HELP = `I can answer questions about your **devices** and **shipments** using the live data. For example:

- "Are there any problems right now?"
- "Is shipment 1001 OK?" / "Why is it flagged?"
- "Which devices have battery below 20%?"
- "Temperature of shipment 1002 per hour today"
- "Which routes had the most alerts this week?"
- "Compare shipments 1001 and 1002"`;

const FIXED: Partial<Record<Plan['task'], string>> = {
  chitchat: `Hi! 👋 ${HELP}`,
  off_topic: `I can only help with your **devices and shipments** — I don't have information about that.

${HELP}`,
  unsupported: `I don't have that kind of data. I can answer questions about **readings** (temperature, humidity, battery, light, acceleration), **alerts**, **shipments** (routes, status, limits) and **devices** — by any device, shipment, route, hour or day.`
};
/** Fixed replies don't change what the conversation is about. */
export const KEEPS_CONTEXT = new Set(Object.keys(FIXED));

const NAMED_SHIPMENTS: Record<string, number> = { pharma: 1001, vaccine: 1002, bio: 1003, perishable: 1004 };

/**
 * Small models copy IDs from the prompt's examples ("what devices are there" came back
 * filtered to DEV-004). The model still decides everything else; a shipment or device
 * only stays if the user named it or the conversation already showed it.
 */
function dropInventedIds(plan: Plan, question: string, ctx: PlannerContext): Plan {
  const q = question.toLowerCase();
  const shipments = new Set([
    ...[...q.matchAll(/\b1\d{3}\b/g)].map(m => Number(m[0])),
    ...Object.entries(NAMED_SHIPMENTS).filter(([name]) => q.includes(name)).map(([, uid]) => uid),
    ...(ctx.shown?.shipments ?? []), ...(ctx.previousPlan?.shipments ?? [])
  ]);
  const devices = new Set([
    ...[...q.matchAll(/\bdev(?:ice)?[\s-]*0*(\d{1,3})\b/g)].map(m => `DEV-${m[1].padStart(3, '0')}`),
    ...(ctx.shown?.devices ?? []), ...(ctx.previousPlan?.devices ?? [])
  ]);
  return { ...plan, shipments: plan.shipments.filter(s => shipments.has(s)), devices: plan.devices.filter(d => devices.has(d)) };
}

export interface PlannedAnswer {
  answer: string;
  /** What the model chose to do (plan.task), for the log. */
  task: string;
  model: string;
  plan: Plan;
}

export async function answerWithPlanner(
  question: string,
  /** The client asking (from authentication) and the data's anchor time. */
  scope: Scope,
  ctx: ChatContext | undefined,
  /** Reviewer's note on what was wrong last time ("Not right?" / `npm run fix`). */
  hint?: string
): Promise<PlannedAnswer> {
  const plannerCtx: PlannerContext = ctx?.lastPrompt
    ? { previousQuestion: ctx.lastPrompt, previousPlan: ctx.plan ? normalizePlan(ctx.plan) : undefined, shown: { shipments: ctx.shipments, devices: ctx.devices } }
    : {};
  const planned = await planQuestion(question, plannerCtx, undefined, hint, scope.clientId);
  const plan = dropInventedIds(planned.plan, question, plannerCtx);
  const done = (answer: string): PlannedAnswer => ({ answer, task: plan.task, model: planned.model, plan });
  const s = plan.shipments, d = plan.devices;
  const { anchor, clientId } = scope;

  const fixed = FIXED[plan.task];
  if (fixed) return done(fixed);
  if (plan.task === 'status' || plan.task === 'explain') {
    if (s.length) return done(await shipmentReport(s[0], scope, plan.task === 'explain'));
    if (d.length) return done(await deviceReport(d[0], scope));
    return done(await fleetOverview(scope));
  }
  if (plan.task === 'compare' && s.length >= 2) return done(await compareShipments(s, scope));

  let task = plan.task;
  if (task === 'compare') task = 'metric';
  if (task === 'metric' && plan.metric === 'none') plan.metric = 'temperature';
  if (task === 'metric' && d.length > 1 && plan.by === 'none') plan.by = 'device';
  if (task === 'metric' && s.length > 1 && plan.by === 'none') plan.by = 'shipment';

  if (task === 'metric') {
    const withPrevious = plan.vs_previous && plan.window !== 'all' && plan.by !== 'hour' && plan.by !== 'day';
    const [rows, prev] = await Promise.all([
      runQuery(buildMetricQuery(plan, anchor.epoch), clientId),
      withPrevious ? runQuery(buildMetricQuery(plan, anchor.epoch, 1), clientId) : Promise.resolve(null)
    ]);
    return done(renderMetric(plan, rows, prev, anchor));
  }
  if (task === 'list_shipments') return done(renderShipments(plan, await runQuery(buildShipmentListQuery(plan, anchor.epoch), clientId)));
  if (task === 'list_devices') return done(renderDevices(plan, await runQuery(buildDeviceListQuery(plan, anchor.epoch), clientId), anchor));
  if (task === 'list_alerts') return done(renderAlerts(plan, await runQuery(buildAlertListQuery(plan, anchor.epoch), clientId)));
  return done(renderReadings(plan, await runQuery(buildReadingsQuery(plan, anchor.epoch), clientId)));
}
