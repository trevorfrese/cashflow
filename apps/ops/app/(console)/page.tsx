'use client';

import {
  CircuitBreakerStatus,
  MonitoringSummary,
  OperatorPortfolio,
  type AlertSeverity,
} from '@cashflow/shared';
import Link from 'next/link';
import { useState } from 'react';

import {
  Button,
  Card,
  Field,
  Load,
  Notice,
  PageHead,
  Pill,
  Refusal,
  SeverityPill,
  Stat,
  StatusPill,
  Table,
} from '@/components/ui';
import { date, dateTime, money, percent, words } from '@/lib/format';
import { SEVERITY } from '@/lib/labels';
import { useIsAdmin } from '@/lib/session-context';
import { useAction, useApi } from '@/lib/use-api';

const SEVERITIES: AlertSeverity[] = ['CRITICAL', 'HIGH', 'WARNING', 'INFO'];

export default function OverviewPage() {
  const summary = useApi('monitoring/summary', MonitoringSummary);
  const book = useApi('portfolio', OperatorPortfolio);

  return (
    <>
      <PageHead
        title="Overview"
        lead="What needs a person right now, whether the jobs ran, and where the book stands."
        actions={
          <Button
            small
            onClick={() => {
              summary.reload();
              book.reload();
            }}
          >
            Refresh
          </Button>
        }
      />

      <Load from={summary} rows={6}>
        {(s) => (
          <div className="stack">
            <Card title="Open alerts" aside={<Link href="/alerts">All alerts</Link>}>
              <div className="stats">
                {SEVERITIES.map((severity) => {
                  const count = s.openBySeverity[severity] ?? 0;
                  return (
                    <Stat
                      key={severity}
                      label={SEVERITY[severity].label}
                      value={count}
                      sub={<SeverityPill severity={severity} />}
                      href={`/alerts?severity=${severity}`}
                      tone={count > 0 && SEVERITY[severity].level >= 3 ? 'bad' : undefined}
                    />
                  );
                })}
                <Stat
                  label="Unacknowledged"
                  value={s.unacknowledged}
                  sub="Nobody has picked these up"
                  href="/alerts?status=OPEN"
                  tone={s.unacknowledged > 0 ? 'warn' : undefined}
                />
              </div>
            </Card>

            <div className="grid-2">
              <Card title="Queues">
                <div className="stats">
                  <Stat
                    label="In review"
                    value={s.applicationsInReview}
                    sub="Applications waiting for a decision"
                    href="/reviews"
                    tone={s.applicationsInReview > 0 ? 'warn' : undefined}
                  />
                  <Stat
                    label="Lease changes"
                    value={s.pendingLeaseChanges}
                    sub="Landlord or payout changes waiting"
                    href="/lease-changes"
                    tone={s.pendingLeaseChanges > 0 ? 'warn' : undefined}
                  />
                  <Stat
                    label="Screening hits"
                    value={s.openScreeningHits}
                    sub="Possible matches nobody has cleared"
                    href="/screening"
                    tone={s.openScreeningHits > 0 ? 'bad' : undefined}
                  />
                </div>
              </Card>
              <BreakerCard breaker={s.circuitBreaker} onReset={summary.reload} />
            </div>

            <Card
              title="Scheduled jobs"
              aside={<span className="muted">As of {date(s.asOf)}</span>}
            >
              <Table
                caption="Last run of every scheduled job"
                head={['Job', 'Last run', 'Ran for date', 'Result', 'Last good date']}
              >
                {s.jobs.map((job) => (
                  <tr key={job.name}>
                    <td className="cell-main">{words(job.name)}</td>
                    <td className="nowrap">
                      {job.lastRun ? dateTime(job.lastRun.startedAt) : 'Never'}
                    </td>
                    <td className="nowrap">{job.lastRun ? date(job.lastRun.asOf) : '-'}</td>
                    <td>
                      {!job.lastRun ? (
                        <Pill>Never run</Pill>
                      ) : job.lastRun.ok === null ? (
                        <Pill tone="info">Running</Pill>
                      ) : job.lastRun.ok ? (
                        <Pill tone="good">OK</Pill>
                      ) : (
                        <>
                          <Pill tone="bad">Failed</Pill>{' '}
                          <span className="small">{job.lastRun.error}</span>
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      {job.lastSuccessAsOf ? date(job.lastSuccessAsOf) : 'Never'}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )}
      </Load>

      <Load from={book} rows={6}>
        {(b) => (
          <div className="stack">
            <Card title="The book" aside={<Link href="/portfolio">Portfolio</Link>}>
              <div className="stats">
                <Stat
                  label="Receivables"
                  value={money(b.delinquency.receivableCents)}
                  sub={`${money(b.delinquency.netReceivableCents)} net of allowance`}
                />
                <Stat
                  label="Allowance"
                  value={money(b.delinquency.allowanceCents)}
                  sub={`Policy calls for ${money(b.delinquency.requiredAllowanceCents)}`}
                />
                <Stat
                  label="Charged off"
                  value={money(b.delinquency.chargedOffCents)}
                  sub={`${b.delinquency.chargedOffPlans} ${b.delinquency.chargedOffPlans === 1 ? 'plan' : 'plans'}, to date`}
                  tone={b.delinquency.chargedOffCents > 0 ? 'bad' : undefined}
                />
                <Stat
                  label="Recovered"
                  value={money(b.delinquency.recoveredCents)}
                  sub="On written off balances"
                />
                <Stat
                  label="Pool cash"
                  value={money(b.pool.cashCents)}
                  sub={`${money(b.pool.capitalCents)} capital with receivables`}
                />
                <Stat
                  label="Utilization"
                  value={percent(b.pool.utilizationBps)}
                  sub={`Ceiling ${percent(b.pool.maxUtilizationBps)}. ${money(b.pool.committedCents)} committed`}
                  tone={
                    b.pool.utilizationBps !== null &&
                    b.pool.utilizationBps >= b.pool.maxUtilizationBps
                      ? 'bad'
                      : undefined
                  }
                />
                <Stat
                  label="Held payouts"
                  value={b.delinquency.heldPayouts}
                  tone={b.delinquency.heldPayouts > 0 ? 'warn' : undefined}
                />
                <Stat
                  label="Frozen plans"
                  value={b.delinquency.frozenPlans}
                  tone={b.delinquency.frozenPlans > 0 ? 'warn' : undefined}
                />
              </div>
            </Card>
            <Card title="Plans by delinquency">
              <Table
                caption="Plans and principal by delinquency bucket"
                head={['Bucket', { num: 'Plans' }, { num: 'Principal outstanding' }]}
              >
                {b.delinquency.buckets.map((bucket) => (
                  <tr key={bucket.status}>
                    <td>
                      <StatusPill code={bucket.status} />
                    </td>
                    <td className="num">{bucket.plans}</td>
                    <td className="num">{money(bucket.principalCents)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )}
      </Load>
    </>
  );
}

function BreakerCard({ breaker, onReset }: { breaker: CircuitBreakerStatus; onReset: () => void }) {
  const isAdmin = useIsAdmin();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const reset = useAction<{ reason: string }, CircuitBreakerStatus>(
    'circuit-breaker/reset',
    CircuitBreakerStatus,
    () => {
      setOpen(false);
      setReason('');
      onReset();
    },
  );
  const valid = reason.trim().length >= 3;

  return (
    <Card
      title="Circuit breaker"
      aside={
        breaker.tripped ? <Pill tone="bad">Tripped</Pill> : <Pill tone="good">Not tripped</Pill>
      }
    >
      {breaker.tripped ? (
        <>
          <Notice tone="bad" title="Automatic approvals are paused">
            <p>
              Applications the engine would approve are going to the review queue instead, until an
              admin resets the breaker.
            </p>
          </Notice>
          <dl className="facts">
            <div>
              <dt>Why</dt>
              <dd>{breaker.reason ?? 'No reason recorded'}</dd>
            </div>
            <div>
              <dt>Tripped</dt>
              <dd>{dateTime(breaker.trippedAt)}</dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd className="mono">{breaker.trippedByRule ?? '-'}</dd>
            </div>
            {breaker.trippedAlertId ? (
              <div>
                <dt>Alert</dt>
                <dd>
                  <Link href={`/alerts/${breaker.trippedAlertId}`}>Open the alert</Link>
                </dd>
              </div>
            ) : null}
          </dl>
          {!isAdmin ? (
            <p className="muted">Resetting the breaker needs the admin role.</p>
          ) : open ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) void reset.run({ reason: reason.trim() });
              }}
            >
              <Field
                label="Why it is safe to resume automatic approvals"
                htmlFor="breaker-reason"
                required
                hint="Recorded in the audit log under your name."
              >
                <textarea
                  id="breaker-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                  required
                />
              </Field>
              <Refusal error={reset.error} />
              <div className="row">
                <Button type="submit" variant="danger" busy={reset.busy} disabled={!valid}>
                  Reset the breaker
                </Button>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div>
              <Button variant="azure" onClick={() => setOpen(true)}>
                Reset
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p>Automatic approvals are running. Clean applications are decided by the engine.</p>
          {breaker.resetAt ? (
            <p className="muted small">
              Last reset {dateTime(breaker.resetAt)} by {breaker.resetBy ?? 'unknown'}
              {breaker.resetReason ? `: ${breaker.resetReason}` : ''}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
