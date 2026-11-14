'use client';

import { TrialBalance, type AccountBalance, type LedgerAccountType } from '@cashflow/shared';
import Link from 'next/link';

import { Button, Card, Empty, Load, Notice, PageHead, Pill, Stat, Table } from '@/components/ui';
import { money } from '@/lib/format';
import { useApi } from '@/lib/use-api';

const TYPES: Array<{ type: LedgerAccountType; title: string; normal: string }> = [
  { type: 'ASSET', title: 'Assets', normal: 'Debit normal' },
  { type: 'LIABILITY', title: 'Liabilities', normal: 'Credit normal' },
  { type: 'EQUITY', title: 'Equity', normal: 'Credit normal' },
  { type: 'REVENUE', title: 'Revenue', normal: 'Credit normal' },
  { type: 'EXPENSE', title: 'Expenses', normal: 'Debit normal' },
];

/**
 * The ledger as the API derives it from entries: every account's debits, credits, and
 * natural balance, grouped by type, and whether the books balance. Read only.
 */
export default function LedgerPage() {
  const tb = useApi('ledger/trial-balance', TrialBalance);
  return (
    <>
      <PageHead
        title="Ledger"
        lead="Account balances and the trial balance, derived from the ledger entries. Balances are never stored: each is the sum of its entries. Read only."
        actions={
          <Button small onClick={tb.reload}>
            Refresh
          </Button>
        }
      />
      <Load from={tb} rows={8}>
        {(t) => (
          <div className="stack">
            <Card
              title="Trial balance"
              aside={
                t.balanced ? (
                  <Pill tone="good">Balanced</Pill>
                ) : (
                  <Pill tone="bad">Out of balance</Pill>
                )
              }
            >
              {!t.balanced ? (
                <Notice tone="bad" title="Debits and credits do not match">
                  <p>
                    Every posting is balanced when it is written, so this means entries were changed
                    outside the ledger service. Treat it as an incident: monitoring raises an alert
                    on it too.
                  </p>
                </Notice>
              ) : null}
              <div className="stats">
                <Stat label="Total debits" value={money(t.totalDebitsCents)} />
                <Stat label="Total credits" value={money(t.totalCreditsCents)} />
                <Stat
                  label="Difference"
                  value={money(t.totalDebitsCents - t.totalCreditsCents)}
                  tone={t.balanced ? undefined : 'bad'}
                />
                <Stat label="Accounts" value={t.accounts.length} />
              </div>
            </Card>
            {TYPES.map(({ type, title, normal }) => {
              const rows = t.accounts.filter((a) => a.account.type === type);
              return (
                <Card
                  key={type}
                  title={title}
                  aside={
                    <span className="muted small">
                      {normal}. Balance {money(rows.reduce((s, a) => s + a.balanceCents, 0))}
                    </span>
                  }
                >
                  {rows.length === 0 ? (
                    <Empty title={`No ${title.toLowerCase()} accounts yet`} />
                  ) : (
                    <AccountsTable rows={rows} caption={`${title} accounts`} />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Load>
    </>
  );
}

function AccountsTable({ rows, caption }: { rows: AccountBalance[]; caption: string }) {
  return (
    <Table
      caption={caption}
      head={['Account', 'Code', 'Owner', { num: 'Debits' }, { num: 'Credits' }, { num: 'Balance' }]}
    >
      {rows.map(({ account, debitsCents, creditsCents, balanceCents }) => (
        <tr key={account.id}>
          <td className="cell-main">{account.name}</td>
          <td className="mono small">{account.code}</td>
          <td>
            {account.ownerType === 'business' && account.ownerId ? (
              <Link href={`/customers/${account.ownerId}`}>Open the customer</Link>
            ) : (
              <span className="muted">{account.ownerType ?? 'CashFlow'}</span>
            )}
          </td>
          <td className="num">{money(debitsCents)}</td>
          <td className="num">{money(creditsCents)}</td>
          <td className="num">{money(balanceCents)}</td>
        </tr>
      ))}
    </Table>
  );
}
