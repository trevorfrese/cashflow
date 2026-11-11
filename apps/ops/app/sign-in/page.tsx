import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CoinMark } from '@/components/CoinMark';
import { currentSession } from '@/lib/server/current-session';

import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  if (await currentSession()) redirect('/');
  const { expired } = await searchParams;
  return (
    <main className="signin">
      <div className="card signin-card">
        <div className="signin-brand">
          <span className="brandmark">
            <CoinMark size={40} decorative />
            CashFlow
          </span>
          <span className="ops-tag">Ops</span>
        </div>
        <div className="stack-tight">
          <h1 className="card-title">Staff sign in</h1>
          <p className="muted">
            The operations console, for staff. It is not the customer app. Sandbox data only: no
            real money moves here.
          </p>
        </div>
        <SignInForm expired={expired === '1'} />
      </div>
    </main>
  );
}
