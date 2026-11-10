import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { startScheduler } from './jobs/index.ts';
import { createProviders } from './providers/index.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const providers = createProviders(config);
const app = await buildApp({ config, db, providers });

let stopScheduler: (() => void) | undefined;
if (config.JOBS_ENABLED) stopScheduler = startScheduler(app.ctx);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stopScheduler?.();
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(
  {
    providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.name])),
    docs: `http://localhost:${config.PORT}/docs`,
  },
  'CashFlow API ready. Mock money only.',
);
