import { loadEnv } from '@/lib/server/env';
import { proxy } from '@/lib/server/handlers';

// The proxy to the CashFlow API. Only the routes listed in lib/server/routes.ts are
// forwarded; the bearer token and X-Admin-Actor are attached here, on the server.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context) {
  const { path } = await context.params;
  return proxy(request, path, { env: loadEnv(), fetch });
}

export const GET = handle;
export const POST = handle;
