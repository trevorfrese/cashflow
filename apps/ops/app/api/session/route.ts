import { loadEnv } from '@/lib/server/env';
import { signIn, signOut, whoAmI } from '@/lib/server/handlers';

// Sign in, who is signed in, sign out. The logic and its tests are in lib/server/handlers.ts.
export const dynamic = 'force-dynamic';

const deps = () => ({ env: loadEnv(), fetch });

export function GET(request: Request) {
  return whoAmI(request, deps());
}

export function POST(request: Request) {
  return signIn(request, deps());
}

export function DELETE(request: Request) {
  return signOut(request, deps());
}
