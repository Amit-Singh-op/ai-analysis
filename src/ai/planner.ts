import { z } from 'zod';
import { config } from '../config.js';
import { exactExample, similarExamples } from './plan-examples.js';

/**
 * Question planner.
 *
 * The local LLM's only job is to turn a question into this small query plan. It never
 * sees or writes numbers: the query builder (analytics/query-builder.ts) runs the plan
 * against PostgreSQL and the answer is written from real rows. Ollama's `format` option
 * constrains decoding to this JSON schema, so the model can only pick known values.
 *
 * Speed: on a CPU the cost is output tokens, so only five fields are required and the
 * model leaves out filters it doesn't need. The system prompt is static, so Ollama keeps
 * it in its prompt cache and each question only pays for its own few tokens.
 */

export const TASKS = ['metric', 'list_shipments', 'list_devices', 'list_alerts', 'readings', 'explain', 'status', 'compare', 'chitchat', 'off_topic', 'unsupported'] as const;
export const METRICS = ['temperature', 'humidity', 'battery', 'light', 'acceleration', 'readings', 'alerts', 'violations', 'time_out_of_range', 'last_seen', 'none'] as const;
export const AGGS = ['avg', 'min', 'max', 'count', 'latest', 'none'] as const;
export const GROUPS = ['none', 'device', 'shipment', 'device_type', 'origin', 'destination', 'route', 'hour', 'day', 'alert_type'] as const;
export const WINDOWS = ['last_1h', 'last_6h', 'last_24h', 'yesterday', 'last_48h', 'last_7d', 'last_30d', 'all'] as const;
const DEVICE_TYPES = ['any', 'cold_chain', 'dry_ice', 'multi_sensor', 'standard'] as const;
const STATUSES = ['any', 'in_transit', 'not_started', 'delivered'] as const;
const ALERT_TYPES = ['any', 'temperature', 'humidity', 'shock', 'battery', 'status'] as const;
const LEVELS = ['any', 'critical', 'warning', 'info'] as const;

export const planSchema = z.object({
  task: z.enum(TASKS),
  metric: z.enum(METRICS),
  agg: z.enum(AGGS),
  by: z.enum(GROUPS),
  window: z.enum(WINDOWS),
  shipments: z.array(z.number().int().min(1000).max(99999)).max(20),
  devices: z.array(z.string().regex(/^DEV-\d{3}$/)).max(20),
  device_type: z.enum(DEVICE_TYPES),
  origin: z.string().max(40),
  destination: z.string().max(40),
  status: z.enum(STATUSES),
  alert_type: z.enum(ALERT_TYPES),
  alert_level: z.enum(LEVELS),
  /** Keep only groups whose value is above / below `value` ("battery below 20"). */
  op: z.enum(['none', 'gt', 'lt']),
  value: z.number().nullable(),
  /** Also run the same numbers for the period before, and show the change. */
  vs_previous: z.boolean(),
  sort: z.enum(['desc', 'asc']),
  limit: z.number().int().min(1).max(500).nullable()
});

export type Plan = z.infer<typeof planSchema>;

export const DEFAULT_PLAN: Plan = {
  task: 'metric', metric: 'none', agg: 'none', by: 'none', window: 'last_24h', shipments: [], devices: [],
  device_type: 'any', origin: '', destination: '', status: 'any', alert_type: 'any', alert_level: 'any',
  op: 'none', value: null, vs_previous: false, sort: 'desc', limit: null
};

const enumProp = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    task: enumProp(TASKS),
    metric: enumProp(METRICS),
    agg: enumProp(AGGS),
    by: enumProp(GROUPS),
    window: enumProp(WINDOWS),
    shipments: { type: 'array', items: { type: 'integer' } },
    devices: { type: 'array', items: { type: 'string' } },
    device_type: enumProp(DEVICE_TYPES),
    origin: { type: 'string' },
    destination: { type: 'string' },
    status: enumProp(STATUSES),
    alert_type: enumProp(ALERT_TYPES),
    alert_level: enumProp(LEVELS),
    op: enumProp(['none', 'gt', 'lt']),
    value: { type: ['number', 'null'] },
    vs_previous: { type: 'boolean' },
    sort: enumProp(['desc', 'asc']),
    limit: { type: ['integer', 'null'] }
  },
  required: ['task', 'metric', 'agg', 'by', 'window']
};

const SYSTEM_PROMPT = `Convert a question about a cold-chain fleet into a JSON query plan. Output only JSON. Leave out fields that keep their default.

DATA: devices DEV-001..DEV-100 (types cold_chain, dry_ice, multi_sensor, standard) send readings every 5 min: temperature °C, humidity %, battery %, light lux, acceleration milli-g.
Shipments 1001-1100 have origin, destination, status (in_transit, not_started, delivered), assigned devices, temperature limits.
Alerts have type (temperature, humidity, shock, battery, status) and level (critical, warning, info).
Named: pharma=1001, vaccine=1002, bio=1003, perishable=1004. "dev 4"/"device 4" = "DEV-004".

task: metric (any number: average/min/max/count/latest, trends, breakdowns, rankings) | list_shipments | list_devices | list_alerts | readings (raw readings) |
 explain (why is X flagged / what went wrong) | status (is X ok / tell me about X) | compare (2+ named shipments side by side) | chitchat | off_topic | unsupported (cost, ETA, drivers, weather).
metric: temperature | humidity | battery | light | acceleration | readings (number of readings) | alerts (alert count) | violations (readings outside the shipment's temperature limits) | time_out_of_range (minutes outside limits) | last_seen (last report time) | none.
agg: avg | min | max | count | latest | none.   by: none | device | shipment | device_type | origin | destination | route | hour | day | alert_type.
window: last_1h | last_6h | last_24h (default, also "today") | yesterday | last_48h | last_7d ("this week") | last_30d | all.
Filters: shipments [numbers], devices ["DEV-004"], device_type, origin/destination (lowercase city), status, alert_type, alert_level.
op gt|lt with value: keep only results above/below a number. vs_previous: true for "compared to last week/before/previous". sort desc (highest/most, default) | asc (lowest/least). limit: N in "top 5".

EXAMPLES
"temperature of 1002 over the last day" {"task":"metric","metric":"temperature","agg":"avg","by":"hour","window":"last_24h","shipments":[1002]}
"daily alert count this week" {"task":"metric","metric":"alerts","agg":"count","by":"day","window":"last_7d"}
"which 5 devices were hottest" {"task":"metric","metric":"temperature","agg":"max","by":"device","window":"last_24h","limit":5}
"average humidity by device type" {"task":"metric","metric":"humidity","agg":"avg","by":"device_type","window":"last_24h"}
"devices with battery under 30" {"task":"metric","metric":"battery","agg":"latest","by":"device","window":"all","op":"lt","value":30,"sort":"asc"}
"which route has the most temperature violations" {"task":"metric","metric":"violations","agg":"count","by":"route","window":"last_7d"}
"how long was each shipment out of range" {"task":"metric","metric":"time_out_of_range","agg":"count","by":"shipment","window":"last_7d"}
"alerts this week vs last week" {"task":"metric","metric":"alerts","agg":"count","by":"none","window":"last_7d","vs_previous":true}
"critical shock alerts per shipment" {"task":"metric","metric":"alerts","agg":"count","by":"shipment","window":"last_7d","alert_type":"shock","alert_level":"critical"}
"in transit shipments from frankfurt" {"task":"list_shipments","metric":"none","agg":"none","by":"none","window":"all","status":"in_transit","origin":"frankfurt"}
"last 10 alerts for DEV-004" {"task":"list_alerts","metric":"none","agg":"none","by":"none","window":"all","devices":["DEV-004"],"limit":10}
"why is 1001 flagged" {"task":"explain","metric":"none","agg":"none","by":"none","window":"last_7d","shipments":[1001]}
"is shipment 1003 ok" {"task":"status","metric":"none","agg":"none","by":"none","window":"all","shipments":[1003]}
"is DEV-012 working" {"task":"status","metric":"none","agg":"none","by":"none","window":"all","devices":["DEV-012"]}
"are there any problems right now" {"task":"status","metric":"none","agg":"none","by":"none","window":"last_24h"}
"compare 1003 and 1004" {"task":"compare","metric":"none","agg":"none","by":"none","window":"all","shipments":[1003,1004]}
"which one is better" (after comparing 1003 and 1004) {"task":"compare","metric":"none","agg":"none","by":"none","window":"all","shipments":[1003,1004]}
"hi" / "thanks" / "what can you do" {"task":"chitchat","metric":"none","agg":"none","by":"none","window":"all"}
"why is the sky blue" / "write me a poem" {"task":"off_topic","metric":"none","agg":"none","by":"none","window":"all"}

VAGUE RANKINGS ("performing best", "worst", "most reliable", "healthiest"): you decide which metric fits the question and conversation best
(e.g. alerts, violations, time_out_of_range, battery) and group by what is being ranked; best = the side with fewer problems.
"which one"/"which of them" = only among the items the PREVIOUS answer listed: put those into shipments/devices.

FOLLOW-UPS: when PREVIOUS is given and the question depends on it ("and humidity?", "by day instead", "only critical", "what about 1003"), copy the previous plan and change only what the question changes. "it"/"the first one" refers to the items listed.
A question that makes sense on its own ("is DEV-004 working", "how many devices are there", "temperature of 1002") is a NEW question: plan it from scratch and ignore PREVIOUS.
"is X working/ok", "how is X doing", "status of X" = task status with X in shipments/devices.`;

export interface PlannerContext {
  previousQuestion?: string;
  previousPlan?: Plan;
  /** Shipments/devices the previous answer showed, in order (for "the first one", "it"). */
  shown?: { shipments?: number[]; devices?: string[] };
}

export interface PlannerResult {
  plan: Plan;
  ms: number;
  model: string;
}

/** Only the fields that differ from the defaults: shorter prompt, faster CPU prompt processing. */
export function compactPlan(p: Plan): Partial<Plan> {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) =>
    ['task', 'metric', 'agg', 'by', 'window'].includes(k) || JSON.stringify(v) !== JSON.stringify((DEFAULT_PLAN as any)[k])));
}

function contextBlock(ctx?: PlannerContext): string {
  const lines: string[] = [];
  if (ctx?.previousQuestion) lines.push(`PREVIOUS question: "${ctx.previousQuestion}"`);
  if (ctx?.previousPlan) lines.push(`PREVIOUS plan: ${JSON.stringify(compactPlan(ctx.previousPlan))}`);
  if (ctx?.shown?.devices?.length) lines.push(`PREVIOUS answer listed devices: ${ctx.shown.devices.slice(0, 8).join(', ')}`);
  if (ctx?.shown?.shipments?.length) lines.push(`PREVIOUS answer listed shipments: ${ctx.shown.shipments.slice(0, 8).join(', ')}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export const plannerModel = () => process.env.PLANNER_MODEL || config.PLANNER_MODEL;

// Same question in the same context -> same plan: skip the model (repeats answer in milliseconds).
const planCache = new Map<string, Plan>();
const PLAN_CACHE_SIZE = 500;

/** Corrected examples similar to this question (from `npm run fix`), as extra few-shot lines. */
function learnedBlock(question: string, clientId?: number): string {
  const examples = similarExamples(question, clientId);
  if (!examples.length) return '';
  // IDs become placeholders, so the model learns the pattern instead of copying DEV-004 into every answer
  const generic = (s: string) => s.replace(/\bdev(?:ice)?[\s-]*\d{1,3}\b/gi, '<DEVICE>').replace(/"?\b1\d{3}\b"?/g, '<SHIPMENT>');
  const lines = examples.map(e => generic(`${e.previousQuestion ? `(after "${e.previousQuestion}") ` : ''}"${e.question}" ${JSON.stringify(e.plan)}`));
  return `CORRECTED EXAMPLES (earlier mistakes, fixed; follow them; <DEVICE>/<SHIPMENT> = the actual one in this question or conversation):\n${lines.join('\n')}\n`;
}

/**
 * `hint`: a reviewer's note on what was wrong last time (`npm run fix`); bypasses saved
 * plans and the cache so the model plans the question again with the note in mind.
 */
export async function planQuestion(
  question: string, ctx?: PlannerContext, model = plannerModel(), hint?: string,
  /** Corrections and cached plans are per client (spec §11): one client's IDs never reach another's prompt. */
  clientId?: number
): Promise<PlannerResult> {
  const t = Date.now();
  if (!hint) {
    const saved = exactExample(question, ctx?.previousQuestion, clientId);
    if (saved) return { plan: normalizePlan(saved.plan), ms: Date.now() - t, model: 'corrected example' };
  }
  const note = hint ? `\nNOTE from a reviewer about the last answer to this question: ${hint}` : '';
  const user = `${learnedBlock(question, clientId)}${contextBlock(ctx)}QUESTION: ${question}${note}`;
  const key = `${clientId ?? '-'}\n${model}\n${user}`;
  const cached = hint ? undefined : planCache.get(key);
  if (cached) return { plan: { ...cached }, ms: Date.now() - t, model: `${model} (cached)` };
  const res = await fetch(`${config.OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(config.PLANNER_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: false,
      format: PLAN_JSON_SCHEMA,
      keep_alive: '60m',
      options: { temperature: 0, num_ctx: 3072, num_predict: 160 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const raw = JSON.parse(body.message?.content ?? '{}');
  const plan = normalizePlan(raw);
  if (planCache.size >= PLAN_CACHE_SIZE) planCache.delete(planCache.keys().next().value!);
  planCache.set(key, plan);
  return { plan: { ...plan }, ms: Date.now() - t, model };
}

/** Load the model and its system prompt into Ollama's cache so the first real question is fast. */
export async function warmPlanner(): Promise<void> {
  try { await planQuestion('average temperature today'); } catch { /* Ollama not running: questions fall back to rules */ }
}

/** Fill gaps and clean values so a slightly-off model output still yields a valid plan. */
export function normalizePlan(raw: any): Plan {
  const merged: any = { ...DEFAULT_PLAN, ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.devices = (Array.isArray(merged.devices) ? merged.devices : [])
    .map((d: any) => String(d).toUpperCase().match(/(\d{1,3})/)?.[1])
    .filter(Boolean)
    .map((n: string) => `DEV-${n.padStart(3, '0')}`);
  merged.shipments = (Array.isArray(merged.shipments) ? merged.shipments : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 1000);
  merged.origin = String(merged.origin ?? '').toLowerCase().trim();
  merged.destination = String(merged.destination ?? '').toLowerCase().trim();
  for (const k of ['value', 'limit'] as const) {
    const v = merged[k];
    merged[k] = v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  }
  if (merged.limit !== null) merged.limit = Math.max(1, Math.min(500, Math.round(merged.limit)));
  if (merged.op === 'none' || merged.value === null) { merged.op = 'none'; merged.value = null; }
  const parsed = planSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Drop any single bad field back to its default rather than failing the whole question.
  for (const issue of parsed.error.issues) merged[issue.path[0]] = (DEFAULT_PLAN as any)[issue.path[0]];
  return planSchema.parse(merged);
}
