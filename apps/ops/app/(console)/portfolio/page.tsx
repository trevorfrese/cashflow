'use client';

import { OperatorEvaluation, OperatorPortfolio, type ConcentrationRow } from '@cashflow/shared';
import Link from 'next/link';

import {
  Button,
  CapBar,
  Card,
  Empty,
  Load,
  Notice,
  PageHead,
  Pill,
  Stat,
  StatusPill,
  Table,
} from '@/components/ui';
import { comparator, date, gateNumber, money, month, percent, words } from '@/lib/format';
import { useApi } from '@/lib/use-api';

export default function PortfolioPage() {
  const book = useApi('portfolio', OperatorPortfolio);
  const evaluation = useApi('policy/evaluation', OperatorEvaluation);
  return (
    <>
      <PageHead
        title="Portfolio"
        lead="The live book, computed from the ledger and the plans as they stand today."
        actions={
          <Button
            small
            onClick={() => {
              book.reload();
              evaluation.reload();
            }}
          >
            Refresh
          </Button>
        }
      />
      <Load from={book} rows={10}>
        {(b) => (
          <div className="stack">
            <Card title="Pool" aside={<span className="muted">As of {date(b.asOf)}</span>}>
              <div className="stats">
                <Stat
                  label="Pool cash"
                  value={money(b.pool.cashCents)}
                  sub="Available to fund payouts"
                />
                <Stat
                  label="Receivables"
                  value={money(b.pool.receivableCents)}
                  sub="Rent fronted and not yet repaid"
                />
                <Stat
                  label="Capital"
                  value={money(b.pool.capitalCents)}
                  sub="Cash plus receivables. Caps are shares of this"
                />
                <Stat
                  label="Committed rent"
                  value={money(b.pool.committedCents)}
                  sub={`${b.plans.active} active, ${b.plans.paused} paused, ${b.plans.closed} closed plans`}
                />
                <Stat
                  label="Utilization"
                  value={percent(b.pool.utilizationBps)}
                  sub={`Ceiling ${percent(b.pool.maxUtilizationBps)}`}
                  tone={
                    b.pool.utilizationBps !== null &&
                    b.pool.utilizationBps >= b.pool.maxUtilizationBps
                      ? 'bad'
                      : undefined
                  }
                />
              </div>
            </Card>

            <div className="grid-2 grid-roomy">
              <Card title="Delinquency by bucket">
                <Table
                  caption="Plans, principal, and reserve by delinquency bucket"
                  head={[
                    'Bucket',
                    { num: 'Plans' },
                    { num: 'Principal' },
                    { num: 'Reserve rate' },
                    { num: 'Reserve needed' },
                  ]}
                >
                  {b.delinquency.buckets.map((bucket) => (
                    <tr key={bucket.status}>
                      <td>
                        <StatusPill code={bucket.status} />
                      </td>
                      <td className="num">{bucket.plans}</td>
                      <td className="num">{money(bucket.principalCents)}</td>
                      <td className="num">
                        {bucket.provisionRateBps === null ? '-' : percent(bucket.provisionRateBps)}
                      </td>
                      <td className="num">{money(bucket.requiredReserveCents)}</td>
                    </tr>
                  ))}
                </Table>
                <p className="muted small">
                  Servicing policy: {b.delinquency.servicingPolicy}. Held payouts:{' '}
                  {b.delinquency.heldPayouts}. Frozen plans: {b.delinquency.frozenPlans}.
                </p>
              </Card>
              <Card title="Loss accounts">
                <div className="stats">
                  <Stat
                    label="Allowance"
                    value={money(b.delinquency.allowanceCents)}
                    sub={`Policy calls for ${money(b.delinquency.requiredAllowanceCents)}`}
                    tone={
                      b.delinquency.allowanceCents < b.delinquency.requiredAllowanceCents
                        ? 'warn'
                        : undefined
                    }
                  />
                  <Stat
                    label="Net receivable"
                    value={money(b.delinquency.netReceivableCents)}
                    sub="Receivables less allowance"
                  />
                  <Stat
                    label="Provision expense"
                    value={money(b.delinquency.provisionExpenseCents)}
                    sub="To date"
                  />
                  <Stat
                    label="Charged off"
                    value={money(b.delinquency.chargedOffCents)}
                    sub={`${b.delinquency.chargedOffPlans} ${b.delinquency.chargedOffPlans === 1 ? 'plan' : 'plans'}, to date`}
                  />
                  <Stat
                    label="Recovered"
                    value={money(b.delinquency.recoveredCents)}
                    sub="On written off balances"
                  />
                </div>
              </Card>
            </div>

            <div className="grid-2 grid-roomy">
              <Concentration
                title="Concentration by industry"
                rows={b.concentration.industries}
                first="Industry"
                label={(row) => words(row.label)}
              />
              <Concentration
                title="Largest businesses"
                rows={b.concentration.businesses}
                first="Business"
                label={(row) => <Link href={`/customers/${row.key}`}>{row.label}</Link>}
              />
            </div>

            <Card title="First payment default by origination month">
              <p className="muted">
                Plans whose very first installment went {b.firstPaymentDefault.defaultDays} days
                past due, was written off, or was paid that late. Monitoring warns at{' '}
                {percent(b.firstPaymentDefault.warnBps)} and goes critical at{' '}
                {percent(b.firstPaymentDefault.criticalBps)}, on months with{' '}
                {b.firstPaymentDefault.minPlans} plans or more.
              </p>
              {b.firstPaymentDefault.cohorts.length === 0 ? (
                <Empty title="No month is old enough to judge yet">
                  A plan counts once its first installment is {b.firstPaymentDefault.defaultDays}{' '}
                  days past its due date.
                </Empty>
              ) : (
                <Table
                  caption="First payment default by origination month"
                  head={[
                    'Originated',
                    { num: 'Plans' },
                    { num: 'Defaults' },
                    { num: 'Rate' },
                    'Reading',
                  ]}
                >
                  {b.firstPaymentDefault.cohorts.map((c) => (
                    <tr key={c.month}>
                      <td className="cell-main">{month(c.month)}</td>
                      <td className="num">{c.plans}</td>
                      <td className="num">{c.defaults}</td>
                      <td className="num">{percent(c.rateBps)}</td>
                      <td>
                        {c.belowMinSample ? (
                          <Pill>Too few plans to read as a rate</Pill>
                        ) : c.rateBps >= b.firstPaymentDefault.criticalBps ? (
                          <Pill tone="bad">Critical</Pill>
                        ) : c.rateBps >= b.firstPaymentDefault.warnBps ? (
                          <Pill tone="warn">Warning</Pill>
                        ) : (
                          <Pill tone="good">Within range</Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </Load>

      <Load from={evaluation} rows={6}>
        {(e) => <Gates evaluation={e} />}
      </Load>
    </>
  );
}

function Concentration({
  title,
  rows,
  first,
  label,
}: {
  title: string;
  rows: ConcentrationRow[];
  first: string;
  label: (row: ConcentrationRow) => React.ReactNode;
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <Empty title="No rent is committed" />
      ) : (
        <Table
          caption={title}
          head={[
            first,
            { num: 'Committed' },
            { num: 'Share of capital' },
            { num: 'Cap' },
            'Against the cap',
          ]}
        >
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="cell-main">{label(row)}</td>
              <td className="num">{money(row.committedCents)}</td>
              <td className="num">{percent(row.shareBps)}</td>
              <td className="num">{percent(row.capBps)}</td>
              <td className="nowrap">
                <CapBar
                  shareBps={row.shareBps}
                  capBps={row.capBps}
                  label={`${percent(row.shareBps)} of capital against a cap of ${percent(row.capBps)}`}
                />{' '}
                {row.overCap ? <Pill tone="bad">Over cap</Pill> : <Pill tone="good">Under</Pill>}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Gates({ evaluation: e }: { evaluation: OperatorEvaluation }) {
  return (
    <Card
      title="Evaluation gates"
      aside={
        e.available ? (
          e.allPass ? (
            <Pill tone="good">All gates pass</Pill>
          ) : (
            <Pill tone="bad">A gate fails</Pill>
          )
        ) : null
      }
    >
      <Notice tone="info" title="These numbers come from simulation, not from the book above">
        <p>
          The gates are judged on a synthetic population run through the credit and servicing
          policy. They show the policy is coherent. They do not show how real borrowers perform.
          Read from <span className="mono">{e.source}</span>, the checked in result of the last
          default evaluation run.
        </p>
      </Notice>
      {!e.available ? (
        <Empty title="No evaluation baseline is available to the API" />
      ) : (
        <>
          <p>
            Policy <span className="mono">{e.policyVersion}</span>, servicing{' '}
            <span className="mono">{e.servicingPolicy}</span>
            {e.run
              ? `. ${e.run.seeds.length} seeds of ${e.run.applicantsPerSeed.toLocaleString('en-US')} applicants over ${e.run.horizonMonths} months, pool of ${money(e.run.poolSizeCents, { whole: true })}.`
              : '.'}
          </p>
          {!e.matchesCurrentPolicy ? (
            <Notice tone="warn" title="The evaluated policy is not the policy in force">
              <p>Rerun the portfolio evaluation for the current policy version.</p>
            </Notice>
          ) : null}
          <Table
            caption="Evaluation gate results"
            head={[
              'Gate',
              { num: 'Value' },
              { num: 'Threshold' },
              { num: 'Lowest and highest seed' },
              'Result',
            ]}
          >
            {e.gates.map((g) => (
              <tr key={g.id}>
                <td>
                  <div className="cell-main">{g.description}</div>
                  <div className="muted small mono">{g.id}</div>
                </td>
                <td className="num">{gateNumber(g.value, g.unit)}</td>
                <td className="num">
                  {comparator(g.comparator)} {gateNumber(g.threshold, g.unit)}
                </td>
                <td className="num">
                  {g.min === null || g.max === null
                    ? '-'
                    : `${gateNumber(g.min, g.unit === 'cents' ? 'cents' : 'plain')} to ${gateNumber(g.max, g.unit === 'cents' ? 'cents' : 'plain')}`}
                </td>
                <td>{g.pass ? <Pill tone="good">Pass</Pill> : <Pill tone="bad">Fail</Pill>}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  );
}
