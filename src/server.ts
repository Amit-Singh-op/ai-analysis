import { app } from './app.js';
import { config } from './config.js';
import { closePools } from './db/pool.js';
import { warmPlanner } from './ai/planner.js';

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`\n===============================================================`);
  console.log(` Local AI Data Analyst Service Started`);
  console.log(` Endpoint: http://${config.HOST}:${config.PORT}`);
  console.log(` Health:   http://${config.HOST}:${config.PORT}/health`);
  console.log(` Mode:     Local-First Prototype (Ollama + PostgreSQL)`);
  console.log(`===============================================================\n`);
  // Load the planner model now so the first question isn't the slow one
  void warmPlanner();
});

// Graceful shutdown handling
function gracefulShutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('[Server] HTTP server closed.');
    await closePools();
    console.log('[Server] Database connection pools closed.');
    process.exit(0);
  });

  // Force shutdown after 10s if hung
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
