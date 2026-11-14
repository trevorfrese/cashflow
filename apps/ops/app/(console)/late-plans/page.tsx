'use client';

import { OperatorLatePlans } from '@cashflow/shared';
import Link from 'next/link';

import {
  Button,
  Card,
  Empty,
  Load,
  PageHead,
  Pill,
  Stat,
  StatusPill,
  Table,
} from '@/components/ui';
import { date, days, money } from '@/lib/format';
import { freezeReason } from '@/lib/labels';
import { useApi } from '@/lib/use-api';

/**
 * Every plan that is behind: the list behind the delinquency summary on the overview and
 * the portfolio. Most days past due first. Read only; what can be done about a plan is on
 * the customer's page.
 */
export default function LatePlansPage() {
  const late = useApi('delinquency/plans', OperatorLatePlans);
  return (
    <>
      <PageHead
        title="Late plans"
        lead="Plans with an installment past due, or out of the current bucket, written off ones included. Most days past due first. Open the customer to act."
        actions={
          <Button small onClick={late.reload}>
            Refresh
          </Button>
        }
      />
      <Load from={late} rows={6}>
        {(l) => {
          const open = l.plans.filter((p) => p.status !== 'CLOSED');
          return (
            <>
              <Card title="Summary" aside={<span className="muted">As of {date(l.asOf)}</span>}>
                <div className="stats">
                  <Stat
                    label="Late plans"
                    value={open.length}
                    sub="Open plans with something past due"
                    tone={open.length > 0 ? 'warn' : undefined}
                  />
                  <Stat
                    label="Past due"
                    value={money(open.reduce((s, p) => s + p.pastDueCents, 0))}
                    sub="On open plans"
                  />
                  <Stat
                    label="Needs a payment"
                    value={open.filter((p) => p.needsPayment).length}
                    sub="Automatic debits have stopped"
                    tone={open.some((p) => p.needsPayment) ? 'bad' : undefined}
                  />
                  <Stat
                    label="Held payouts"
                    value={l.plans.reduce((s, p) => s + p.heldPayouts, 0)}
                    sub={money(l.plans.reduce((s, p) => s + p.heldPayoutCents, 0))}
                  />
                  <Stat
                    label="Written off"
                    value={l.plans.filter((p) => p.bucket === 'CHARGED_OFF').length}
                    sub="Still owed, plan closed"
                  />
                </div>
              </Card>
              <Card title="Plans">
                {l.plans.length === 0 ? (
                  <Empty title="No plan is behind">Every plan is current.</Empty>
                ) : (
                  <Table
                    caption="Late plans"
                    head={[
                      'Business',
                      'Bucket',
                      { num: 'Days past due' },
                      { num: 'Past due' },
                      { num: 'Monthly rent' },
                      'Payout held',
                      'Collection',
                      'Plan',
                    ]}
                  >
                    {l.plans.map((p) => (
                      <tr key={p.planId}>
                        <td>
                          <Link className="cell-main" href={`/customers/${p.businessId}`}>
                            {p.businessName}
                          </Link>
                          <div className="muted small">
                            {p.kind === 'PASS_THROUGH' ? 'Pass-through' : 'Financed'}
                          </div>
                        </td>
                        <td>
                          <StatusPill code={p.bucket} />
                        </td>
                        <td className="num">{days(p.daysPastDue)}</td>
                        <td className="num">{money(p.pastDueCents)}</td>
                        <td className="num">{money(p.monthlyRentCents)}</td>
                        <td>
                          {p.heldPayouts > 0 ? (
                            <>
                              <Pill tone="warn">
                                {p.heldPayouts === 1 ? 'Held' : `${p.heldPayouts} held`}
                              </Pill>
                              <div className="small nowrap">{money(p.heldPayoutCents)}</div>
                              {p.heldReleaseBy ? (
                                <div className="muted small nowrap">
                                  Release by {date(p.heldReleaseBy)}
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="muted">No</span>
                          )}
                        </td>
                        <td>
                          {p.needsPayment ? (
                            <Pill tone="bad">Needs a payment</Pill>
                          ) : (
                            <span className="muted small">Automatic debits continue</span>
                          )}
                        </td>
                        <td>
                          <StatusPill code={p.status} />
                          {p.frozenReason ? (
                            <div className="small">Frozen: {freezeReason(p.frozenReason)}</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            </>
          );
        }}
      </Load>
    </>
  );
}
