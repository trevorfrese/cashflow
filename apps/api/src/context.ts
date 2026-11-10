import type { FastifyBaseLogger } from 'fastify';

import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Providers } from './providers/index.ts';

export interface AppContext {
  config: Config;
  db: Db;
  providers: Providers;
  log: FastifyBaseLogger;
}
