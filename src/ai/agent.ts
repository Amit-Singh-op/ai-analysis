import { answerWithPlanner, KEEPS_CONTEXT } from './plan-answer.js';
import { compactPlan } from './planner.js';
import { logQuery } from './query-log.js';
import { Anchor, ChatContext, buildContext, DAY } from './format.js';
import { runQuery } from '../analytics/query-builder.js';
import { config } from '../config.js';

export interface AnalystQueryOptions {
  /** The client the user belongs to. From authentication only, never from the model or the request body. */
  clientId: number;
  /** The authenticated user, for the audit log. */
  userId: string;
  /** What the previous answer in this chat was about, for follow-up questions. */
  context?: ChatContext;
  /** What was wrong last time; the model plans the question again with it ("Not right?"). */
  hint?: string;
}

export interface AnalystResponse {
  answer: string;
  context?: ChatContext;
  /** Plan the model wrote (absent when the model couldn't be reached). */
  plan?: Record<string, unknown>;
  task: string;
  executionTimeMs: number;
}

const QUERY_FAILED = `Sorry, I couldn't run that query. Please try rephrasing the question.`;
const OFFLINE = `I can't answer right now: the local AI model isn't responding. Please make sure Ollama is running (\`ollama serve\`) and try again.`;

const anchorCache = new Map<number, { value: Anchor; expires: number }>();

/**
 * The client's newest reading: "yesterday" / "last 24 hours" are relative to the data, not
 * the clock. Per client (one client's data never sets another's "now"), cached briefly.
 */
async function getAnchorTime(clientId: number): Promise<Anchor> {
  const cached = anchorCache.get(clientId);
  if (cached && cached.expires > Date.now()) return cached.value;
  const now = Math.floor(Date.now() / 1000);
  let epoch = now;
  try {
    const [row] = await runQuery({
      text: 'SELECT MAX(timestamp) AS max_time FROM v_pings_enriched WHERE timestamp > $1 AND timestamp <= $2',
      values: [now - config.MAX_WINDOW_DAYS * DAY, now]
    }, clientId);
    epoch = row?.max_time ?? now;
  } catch { /* no data yet: use the clock */ }
  const value = { epoch, iso: new Date(epoch * 1000).toISOString() };
  anchorCache.set(clientId, { value, expires: Date.now() + 15000 });
  return value;
}

/** The local LLM plans every question; the query builder runs the plan for this client and the answer is written from the rows. */
export async function askAnalyst(prompt: string, options: AnalystQueryOptions): Promise<AnalystResponse> {
  const start = Date.now();
  const { clientId, userId } = options;
  let res: Omit<AnalystResponse, 'executionTimeMs'>;
  let model = 'none';
  try {
    const planned = await answerWithPlanner(prompt, { anchor: await getAnchorTime(clientId), clientId }, options.context, options.hint);
    model = planned.model;
    const plan = compactPlan(planned.plan);
    res = {
      answer: planned.answer,
      task: planned.task,
      plan,
      context: KEEPS_CONTEXT.has(planned.task) ? options.context : buildContext(prompt, planned.answer, planned.plan)
    };
  } catch (err: any) {
    const modelDown = err?.name === 'TimeoutError' || /fetch failed|Planner failed|ECONNREFUSED/.test(String(err?.message));
    console.warn(`[${modelDown ? 'planner' : 'query'}] ${err?.message ?? err}`);
    res = { answer: modelDown ? OFFLINE : QUERY_FAILED, task: modelDown ? 'offline' : 'error', context: options.context };
  }
  const executionTimeMs = Date.now() - start;
  logQuery({
    clientId,
    userId,
    prompt,
    intent: res.task,
    matchedBy: model,
    confidence: 0,
    ms: executionTimeMs,
    tools: [],
    plan: res.plan,
    previousQuestion: options.context?.lastPrompt,
    context: options.context as Record<string, unknown> | undefined
  });
  return { ...res, executionTimeMs };
}
