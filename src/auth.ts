import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

/**
 * Who is asking. client_id and user_id come only from here (authentication), never from
 * the request body, the conversation context or the model (spec §3, §11).
 *
 * JWT/SSO verification is the next step (spec build order step 6). Until it is configured:
 *   - development: every request acts as DEV_CLIENT_ID; the X-Dev-Client-Id header can pick
 *     another client, for testing isolation by hand;
 *   - production: every request is refused.
 */
export interface Identity { clientId: number; userId: string }

declare module 'express-serve-static-core' {
  interface Request { identity?: Identity }
}

const isProduction = () => process.env.NODE_ENV === 'production';

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (isProduction() || !config.DEV_CLIENT_ID) {
    res.status(503).json({ error: 'Sign-in is not configured on this server yet.' });
    return;
  }
  const override = req.header('x-dev-client-id');
  const clientId = override !== undefined ? Number(override) : config.DEV_CLIENT_ID;
  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    res.status(400).json({ error: 'Invalid X-Dev-Client-Id' });
    return;
  }
  req.identity = { clientId, userId: `dev-user-${clientId}` };
  next();
}
