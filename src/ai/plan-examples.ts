import fs from 'node:fs';
import path from 'node:path';
import type { Plan } from './planner.js';

/**
 * Corrected question → plan pairs, saved with `npm run fix`.
 *
 * The planner shows the model the most similar ones as examples, so a mistake that was
 * corrected once stops happening for similar wording too. An exact repeat of a corrected
 * question (in the same place in a conversation) uses the saved plan and skips the model.
 */

export const EXAMPLES_FILE = path.resolve(process.cwd(), process.env.PLAN_EXAMPLES_FILE || 'data/plan-examples.json');

export interface PlanExample {
  /** Client whose user saved it; only that client's questions use it (spec §11). */
  clientId?: number;
  question: string;
  /** The question asked just before, when the correction was for a follow-up. */
  previousQuestion?: string;
  plan: Partial<Plan>;
  /** What was wrong, in the reviewer's words. */
  note?: string;
  ts: string;
}

let cache: { mtimeMs: number; examples: PlanExample[] } | null = null;

export function loadExamples(): PlanExample[] {
  try {
    const { mtimeMs } = fs.statSync(EXAMPLES_FILE);
    if (cache?.mtimeMs !== mtimeMs) cache = { mtimeMs, examples: JSON.parse(fs.readFileSync(EXAMPLES_FILE, 'utf8')) };
    return cache.examples;
  } catch {
    return [];
  }
}

export function saveExample(example: PlanExample): void {
  const key = (e: PlanExample) => `${e.clientId ?? '-'}\n${normalize(e.previousQuestion ?? '')}\n${normalize(e.question)}`;
  const examples = loadExamples().filter(e => key(e) !== key(example));
  examples.push(example);
  fs.mkdirSync(path.dirname(EXAMPLES_FILE), { recursive: true });
  fs.writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2) + '\n');
  cache = null;
}

const normalize = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Words and word pairs, with IDs reduced to their kind so "is 1001 ok" matches "is 1005 ok". */
function features(s: string): Set<string> {
  const words = normalize(s)
    .replace(/\bdev(?:ice)?[\s-]*\d{1,3}\b/g, 'DEVICEID')
    .replace(/\b1\d{3}\b/g, 'SHIPMENTID')
    .split(' ')
    .filter(Boolean);
  const out = new Set(words);
  for (let i = 1; i < words.length; i++) out.add(`${words[i - 1]} ${words[i]}`);
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const f of a) if (b.has(f)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

/** Saved plan for exactly this question in this place in the conversation, if any. */
export function exactExample(question: string, previousQuestion?: string, clientId?: number): PlanExample | undefined {
  const q = normalize(question);
  return loadExamples().find(e => e.clientId === clientId && normalize(e.question) === q
    && (!e.previousQuestion || normalize(e.previousQuestion) === normalize(previousQuestion ?? '')));
}

/** The corrected examples most similar to this question. */
export function similarExamples(question: string, clientId?: number, limit = 3, minScore = 0.2): PlanExample[] {
  const q = features(question);
  return loadExamples()
    .filter(e => e.clientId === clientId)
    .map(e => ({ e, score: similarity(q, features(e.question)) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.e);
}
