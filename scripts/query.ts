import { askAnalyst } from '../src/ai/agent.js';
import { closePools } from '../src/db/pool.js';
import { config } from '../src/config.js';

// Ask one question from the command line, as a client:  npm run query -- --client 1 "is shipment 1001 ok"
const args = process.argv.slice(2);
const at = args.indexOf('--client');
const clientId = at >= 0 ? Number(args.splice(at, 2)[1]) : config.DEV_CLIENT_ID;
if (!clientId) throw new Error('Pass --client <id> (or set DEV_CLIENT_ID)');
const question = args.join(' ').trim() || 'Are there any problems right now?';

try {
  const res = await askAnalyst(question, { clientId, userId: 'cli' });
  console.log(`\n${question}\n`);
  console.log(res.answer);
  console.log(`\nPlan: ${JSON.stringify(res.plan ?? null)}`);
  console.log(`Time: ${res.executionTimeMs} ms\n`);
} finally {
  await closePools();
}
