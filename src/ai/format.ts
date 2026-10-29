/** Formatting helpers for answers, and the conversation context sent back with each answer. */

export const HOUR = 3600;
export const DAY = 86400;
const TABLE_ROWS = 25;

export type Anchor = { epoch: number; iso: string };

/**
 * What the previous answer was about. The browser keeps it per tab and sends it back with
 * the next question, so the model can understand follow-ups ("it", "the second one").
 */
export interface ChatContext {
  lastPrompt?: string;
  /** Query plan behind the last answer. */
  plan?: Record<string, unknown>;
  /** Shipments / devices the answer showed, in the order a reader sees them. */
  shipments?: number[];
  devices?: string[];
}

export function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return 'never';
  return new Date(epoch * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtAgo(seconds: number): string {
  if (seconds < 90) return 'just now';
  if (seconds < 2 * HOUR) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 2 * DAY) return `${Math.round(seconds / HOUR)} hours ago`;
  return `${Math.round(seconds / DAY)} days ago`;
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(digits).replace(/\.0+$/, '');
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${(minutes / 1440).toFixed(1).replace(/\.0$/, '')} days`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function prettyType(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

export const city = (s: string) => String(s).split(',')[0];

export function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return '';
  let t = `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n`;
  for (const r of rows.slice(0, TABLE_ROWS)) t += `| ${r.join(' | ')} |\n`;
  if (rows.length > TABLE_ROWS) t += `\n_…and ${rows.length - TABLE_ROWS} more._\n`;
  return t;
}

/** Context for the next question: the plan, plus what the question named and the answer showed. */
export function buildContext(prompt: string, answer: string, plan?: Record<string, unknown>): ChatContext {
  const named = plan as { shipments?: number[]; devices?: string[] } | undefined;
  const shipments = [...(named?.shipments ?? []), ...[...answer.matchAll(/\b1\d{3}\b/g)].map(m => Number(m[0]))];
  const devices = [...(named?.devices ?? []), ...[...answer.matchAll(/\bDEV-\d{3}\b/g)].map(m => m[0])];
  return {
    lastPrompt: prompt,
    plan,
    shipments: Array.from(new Set(shipments)).slice(0, 20),
    devices: Array.from(new Set(devices)).slice(0, 20)
  };
}
