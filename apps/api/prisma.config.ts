import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI config. DATABASE_URL comes from .env (loaded above) or the environment.
// Tests point DATABASE_URL at the test database before running migrations.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --env-file-if-exists=.env prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://cashflow:cashflow@localhost:5432/cashflow',
  },
});
