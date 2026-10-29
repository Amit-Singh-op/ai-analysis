import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  // Tenant-scoped, view-only role (database/tenancy.sql); every query sets app.client_id
  DATABASE_RO_URL: z.string().default('postgresql://analyst_ro:analyst_ro_password@127.0.0.1:5434/telemetry_db'),
  DATABASE_ADMIN_URL: z.string().default('postgresql://analyst_admin:analyst_secret@127.0.0.1:5434/telemetry_db'),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  // Local model that turns each question into a query plan (src/ai/planner.ts)
  PLANNER_MODEL: z.string().default('llama3.2:3b'),
  PLANNER_TIMEOUT_MS: z.coerce.number().default(45000),
  // Query limits (spec §6, §7)
  MAX_WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  MAX_ROWS: z.coerce.number().int().positive().max(1000).default(200),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // Development only: the client every request acts as until JWT auth is configured. Refused in production.
  DEV_CLIENT_ID: z.coerce.number().int().positive().optional(),
  ANCHOR_TIME: z.coerce.number().optional() // Epoch seconds for synthetic seed calculations
});

export const config = envSchema.parse(process.env);

/**
 * Strict localhost guard.
 * Validates that the provided connection string connects only to localhost or 127.0.0.1.
 * Prevents accidental execution against staging or production environments.
 */
export function assertLocalDatabaseUrl(databaseUrl: string, operationName = 'database operation'): void {
  try {
    const url = new URL(databaseUrl);
    const host = url.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
    
    if (!isLocal) {
      throw new Error(
        `[SECURITY GUARD] Prohibited ${operationName} against non-local host "${host}". Only localhost/127.0.0.1 is permitted.`
      );
    }
  } catch (err: any) {
    if (err.message.includes('[SECURITY GUARD]')) {
      throw err;
    }
    throw new Error(`[SECURITY GUARD] Invalid database URL for ${operationName}: ${err.message}`);
  }
}
