'use client';

import { MonitoringSummary } from '@cashflow/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { CoinMark } from '@/components/CoinMark';
import { Button, Pill } from '@/components/ui';
import { OperatorProvider, type Operator } from '@/lib/session-context';
import { useApi } from '@/lib/use-api';

type CountKey = 'reviews' | 'alerts' | 'leaseChanges' | 'screening';

const NAV: Array<{ href: string; label: string; count?: CountKey }> = [
  { href: '/', label: 'Overview' },
  { href: '/reviews', label: 'Review queue', count: 'reviews' },
  { href: '/alerts', label: 'Alerts', count: 'alerts' },
  { href: '/lease-changes', label: 'Lease changes', count: 'leaseChanges' },
  { href: '/screening', label: 'Screening', count: 'screening' },
  { href: '/late-plans', label: 'Late plans' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/customers', label: 'Customers' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/audit', label: 'Audit log' },
  { href: '/policy', label: 'Policy' },
];

const COUNT_WORDS: Record<CountKey, string> = {
  reviews: 'applications in review',
  alerts: 'open alerts',
  leaseChanges: 'pending lease changes',
  screening: 'open screening hits',
};

/** The frame around every console page: the Ops header, who is signed in, and the nav. */
export function Shell({ operator, children }: { operator: Operator; children: ReactNode }) {
  const pathname = usePathname();
  const summary = useApi('monitoring/summary', MonitoringSummary);
  const [leaving, setLeaving] = useState(false);

  const counts: Record<CountKey, number> | null = summary.data
    ? {
        reviews: summary.data.applicationsInReview,
        alerts: Object.values(summary.data.openBySeverity).reduce((a, b) => a + (b ?? 0), 0),
        leaseChanges: summary.data.pendingLeaseChanges,
        screening: summary.data.openScreeningHits,
      }
    : null;

  async function signOut() {
    setLeaving(true);
    try {
      await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' });
    } finally {
      window.location.assign('/sign-in');
    }
  }

  return (
    <OperatorProvider operator={operator}>
      <div className="shell">
        <header className="topbar">
          <div className="row">
            <Link className="brandmark" href="/" aria-label="CashFlow Ops, overview">
              <CoinMark size={30} decorative />
              CashFlow
            </Link>
            <span className="ops-tag">Ops</span>
            <span className="sandbox-note">Staff console. Sandbox data, no real money.</span>
          </div>
          <div className="who">
            <span className="who-name" title={operator.actor}>
              {operator.actor}
            </span>
            <Pill tone={operator.role === 'admin' ? 'info' : 'neutral'}>{operator.role}</Pill>
            <Button small onClick={signOut} busy={leaving}>
              Sign out
            </Button>
          </div>
        </header>
        <nav className="nav" aria-label="Console">
          <ul>
            {NAV.map((item) => {
              const current = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const count = item.count && counts ? counts[item.count] : null;
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={current ? 'page' : undefined}>
                    {item.label}
                    {item.count && count !== null ? (
                      <span
                        className={`nav-count${count === 0 ? ' nav-count-zero' : ''}`}
                        aria-label={`${count} ${COUNT_WORDS[item.count]}`}
                      >
                        {count}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="main">
          <div className="main-inner">{children}</div>
        </main>
      </div>
    </OperatorProvider>
  );
}
