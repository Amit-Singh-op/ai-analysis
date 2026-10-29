import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only JSONL log of every question (and, for older logs, 👍/👎 ratings).
 *
 * These are the training data for the learned router: `npm run review` reads
 * them to surface prompts that fell through or got a thumbs-down. Logging goes
 * to files (not Postgres) so the app's database role stays SELECT-only, and
 * writes are buffered streams so they never slow down a response.
 */

export const LOG_DIR = path.resolve(process.cwd(), process.env.QUERY_LOG_DIR || 'logs');
export const QUERY_LOG = path.join(LOG_DIR, 'queries.jsonl');
export const FEEDBACK_LOG = path.join(LOG_DIR, 'feedback.jsonl');

export interface QueryLogEntry {
  id: string;
  ts: string;
  /** Who asked (from authentication). */
  clientId?: number;
  userId?: string;
  prompt: string;
  intent: string;
  matchedBy: string;
  confidence: number;
  ms: number;
  tools: string[];
  /** Plan the local model wrote (for `npm run fix`). */
  plan?: Record<string, unknown>;
  /** Question asked just before, so follow-ups can be replayed with their context. */
  previousQuestion?: string;
  /** Conversation context sent with the question (for replaying follow-ups in `npm run fix`). */
  context?: Record<string, unknown>;
}

export interface FeedbackEntry {
  id: string;
  ts: string;
  rating: 'up' | 'down';
  note?: string;
}

const enabled = process.env.QUERY_LOG !== 'off' && process.env.NODE_ENV !== 'test';
const streams = new Map<string, fs.WriteStream>();

function append(file: string, entry: object): void {
  if (!enabled) return;
  let stream = streams.get(file);
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', err => console.error(`[query-log] ${err.message}`));
    streams.set(file, stream);
  }
  stream.write(JSON.stringify(entry) + '\n');
}

export function logQuery(entry: Omit<QueryLogEntry, 'id' | 'ts'>): string {
  const id = randomUUID();
  append(QUERY_LOG, { id, ts: new Date().toISOString(), ...entry });
  return id;
}


export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
}
