import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-examples-'));
process.env.PLAN_EXAMPLES_FILE = path.join(dir, 'plan-examples.json');
const { saveExample, exactExample, similarExamples, loadExamples } = await import('../src/ai/plan-examples.js');

describe('plan examples (npm run fix)', () => {
  beforeAll(() => {
    saveExample({
      question: 'which shipments is it on', previousQuestion: 'is DEV-004 working',
      plan: { task: 'list_shipments', devices: ['DEV-004'] }, ts: new Date().toISOString()
    });
    saveExample({ question: 'average battery by device type', plan: { task: 'metric', metric: 'battery', agg: 'avg', by: 'device_type' }, ts: new Date().toISOString() });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses a saved plan only in the same place in the conversation', () => {
    expect(exactExample('Which shipments is it on?', 'is DEV-004 working')?.plan.task).toBe('list_shipments');
    expect(exactExample('which shipments is it on', 'is DEV-002 working')).toBeUndefined();
    expect(exactExample('Average battery by device type')?.plan.by).toBe('device_type');
  });

  it('finds similar corrections, ignoring which device or shipment is named', () => {
    expect(similarExamples('which shipments is DEV-002 on')[0]?.question).toBe('which shipments is it on');
    expect(similarExamples('mean battery per device type')[0]?.question).toBe('average battery by device type');
    expect(similarExamples('hello')).toHaveLength(0);
  });

  it('replaces an earlier correction of the same question', () => {
    saveExample({ question: 'average battery by device type', plan: { task: 'metric', metric: 'battery', agg: 'min', by: 'device_type' }, ts: new Date().toISOString() });
    const matches = loadExamples().filter(e => e.question === 'average battery by device type');
    expect(matches).toHaveLength(1);
    expect(matches[0].plan.agg).toBe('min');
  });
});
