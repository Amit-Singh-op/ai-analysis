import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { askAnalyst } from '../ai/agent.js';
import { compactPlan, normalizePlan } from '../ai/planner.js';
import { saveExample } from '../ai/plan-examples.js';
import { authenticate } from '../auth.js';

export const chatRouter = Router();
chatRouter.use(authenticate);

// What the previous answer in this chat tab was about (returned as `context`), for follow-ups
const contextSchema = z.object({
  lastPrompt: z.string().max(2000).optional(),
  plan: z.record(z.unknown()).optional(),
  shipments: z.array(z.number().int()).max(20).optional(),
  devices: z.array(z.string().max(16)).max(20).optional()
}).optional();

const chatRequestSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt cannot be empty').max(2000, 'Prompt cannot exceed 2000 characters'),
  context: contextSchema
});

const firstError = (err: z.ZodError) => err.errors[0]?.message ?? 'Invalid request';

chatRouter.post('/', async (req: Request, res: Response) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstError(parsed.error) });
    return;
  }
  try {
    const { prompt, context } = parsed.data;
    const result = await askAnalyst(prompt, { ...req.identity!, context });
    res.json({ answer: result.answer, context: result.context });
  } catch (error: any) {
    console.error('[chat]', error);
    res.status(500).json({ error: 'Something went wrong while answering. Please try again.' });
  }
});

const fixSchema = chatRequestSchema.extend({
  note: z.string().trim().min(1, 'Say what was wrong').max(500)
});

// "Not right?" in the chat: answer the question again with the user's note in mind (nothing saved yet)
chatRouter.post('/fix', async (req: Request, res: Response) => {
  const parsed = fixSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstError(parsed.error) });
    return;
  }
  try {
    const { prompt, context, note } = parsed.data;
    const result = await askAnalyst(prompt, { ...req.identity!, context, hint: note });
    if (!result.plan) {
      res.status(503).json({ error: result.answer });
      return;
    }
    res.json({ answer: result.answer, context: result.context, plan: result.plan });
  } catch (error: any) {
    console.error('[chat/fix]', error);
    res.status(500).json({ error: 'Something went wrong while trying again. Please try again.' });
  }
});

const saveSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  previousQuestion: z.string().max(2000).optional(),
  note: z.string().trim().max(500).optional(),
  plan: z.record(z.unknown())
});

// "Save" after a fix: remember the corrected plan so the model doesn't repeat the mistake
chatRouter.post('/fix/save', (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const { prompt, previousQuestion, note, plan } = parsed.data;
  saveExample({ clientId: req.identity!.clientId, question: prompt, previousQuestion, plan: compactPlan(normalizePlan(plan)), note, ts: new Date().toISOString() });
  res.json({ saved: true });
});
