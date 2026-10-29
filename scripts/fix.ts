/**
 * Teach the planner from its mistakes.
 *
 *   npm run fix                              list recent questions the model answered
 *   npm run fix -- 3 "only DEV-004's shipments, no status filter"
 *   npm run fix -- "which shipments is it on" "should list all shipments of the device"
 *
 * The model plans the question again with your note, you see the new answer, and if it's
 * right it is saved to data/plan-examples.json. From then on that exact question uses the
 * saved plan, and similar questions get it as an example, so the mistake doesn't repeat.
 */
import readline from 'node:readline/promises';
import { askAnalyst } from '../src/ai/agent.js';
import { closePools } from '../src/db/pool.js';
import { QUERY_LOG, readJsonl, QueryLogEntry } from '../src/ai/query-log.js';
import { saveExample, EXAMPLES_FILE } from '../src/ai/plan-examples.js';
import type { ChatContext } from '../src/ai/format.js';
import { config } from '../src/config.js';

const RECENT = 20;
const original = (e: QueryLogEntry) => e.prompt.split('  =>  ')[0]; // older logs: 'question  =>  rewritten'

function recent(): QueryLogEntry[] {
  return readJsonl<QueryLogEntry>(QUERY_LOG).filter(e => e.plan).slice(-RECENT).reverse();
}

function list(): void {
  const entries = recent();
  if (!entries.length) {
    console.log('No questions answered by the model yet. Ask some in the app first.');
    return;
  }
  console.log(`Recent questions (newest first):\n`);
  entries.forEach((e, i) => {
    const after = e.previousQuestion ? `   (after "${e.previousQuestion}")` : '';
    console.log(`${String(i + 1).padStart(3)}. ${original(e)}${after}`);
  });
  console.log(`\nTo fix one:  npm run fix -- <number> "what was wrong / what you meant"`);
}

async function fix(target: string, note: string): Promise<void> {
  const entries = recent();
  const byNumber = /^\d+$/.test(target) ? entries[Number(target) - 1] : undefined;
  const entry = byNumber ?? entries.find(e => original(e).toLowerCase() === target.toLowerCase());
  const question = entry ? original(entry) : target;
  const context = entry?.context as ChatContext | undefined;

  console.log(`\nQuestion: ${question}${entry?.previousQuestion ? `   (after "${entry.previousQuestion}")` : ''}`);
  if (entry?.plan) console.log(`Old plan: ${JSON.stringify(entry.plan)}`);
  console.log(`Note:     ${note}\n\nAsking the model again…\n`);

  const clientId = entry?.clientId ?? config.DEV_CLIENT_ID;
  if (!clientId) throw new Error('Unknown client for this question (set DEV_CLIENT_ID)');
  const res = await askAnalyst(question, { clientId, userId: 'cli-fix', context, hint: note });
  const plan = res.plan;
  if (!plan) {
    console.log(`The model didn't produce a plan (Ollama may be offline). Nothing saved.`);
    return;
  }
  console.log(`New plan: ${JSON.stringify(plan)}\n`);
  console.log(res.answer.split('\n').slice(0, 25).join('\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question('\nIs this answer right? Save it so the model learns it (y/n) ')).trim().toLowerCase();
  rl.close();
  if (ok !== 'y' && ok !== 'yes') {
    console.log('Not saved. Try again with a clearer note.');
    return;
  }
  saveExample({ clientId, question, previousQuestion: entry?.previousQuestion, plan, note, ts: new Date().toISOString() });
  console.log(`Saved to ${EXAMPLES_FILE}. The app picks it up on the next question (no restart needed).`);
}

const [target, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim();
try {
  if (!target) list();
  else if (!note) console.log('Add a note saying what was wrong, e.g.  npm run fix -- 3 "should include all shipments"');
  else await fix(target, note);
} finally {
  await closePools();
}
