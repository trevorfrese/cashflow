import { redirect } from 'next/navigation';

import { Shell } from '@/components/Shell';
import { currentSession } from '@/lib/server/current-session';

/**
 * Every console page sits under this layout, and it renders nothing without a session: no
 * cookie, or one that does not open, goes to sign in. The browser is told the operator's
 * name and role. The token stays in the sealed cookie.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session) redirect('/sign-in');
  return <Shell operator={{ actor: session.actor, role: session.role }}>{children}</Shell>;
}
