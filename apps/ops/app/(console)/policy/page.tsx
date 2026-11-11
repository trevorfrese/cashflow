'use client';

import { OperatorPolicy, type PolicySection } from '@cashflow/shared';
import Link from 'next/link';

import { Card, Load, Notice, PageHead, Pill, StatusPill, Table } from '@/components/ui';
import { byUnit, fieldLabel, money, percent, words } from '@/lib/format';
import { integrityAction, integrityLabel } from '@/lib/labels';
import { useApi } from '@/lib/use-api';

export default function PolicyPage() {
  const policy = useApi('policy', OperatorPolicy);
  return (
    <>
      <PageHead
        title="Policy"
        lead="The numbers in force, for reading a decision, an alert, or a plan's standing. Read only: a policy change is a code change that has to pass the evaluation gates."
      />
      <Notice tone="warn" title="Staff only">
        <p>
          Cutoffs, weights, and thresholds are not shown to applicants or customers. Do not quote
          them outside the team.
        </p>
      </Notice>
      <Load from={policy} rows={12}>
        {(p) => (
          <div className="stack">
            <Card title="Versions" aside={<Link href="/portfolio">Evaluation gate results</Link>}>
              <div className="row">
                <span>Credit policy</span>
                <Pill tone="info">{p.creditPolicyVersion}</Pill>
                <span>Servicing policy</span>
                <Pill tone="info">{p.servicingPolicy}</Pill>
              </div>
            </Card>

            <div className="grid-2">
              {p.sections.slice(0, 4).map((s) => (
                <Section key={s.id} section={s} />
              ))}
            </div>

            <div className="grid-2">
              <Card title="Grades, fee floors, and rent share">
                <Table
                  caption="Grade table"
                  head={[
                    'Grade',
                    { num: 'Score from' },
                    { num: 'Fee floor' },
                    { num: 'Rent share of revenue, at most' },
                  ]}
                >
                  {p.gradeTable.map((g) => (
                    <tr key={g.grade}>
                      <td className="cell-main">{g.grade}</td>
                      <td className="num">{g.minScore}</td>
                      <td className="num">{percent(g.feeFloorBps)}</td>
                      <td className="num">{percent(g.maxRentShareBps)}</td>
                    </tr>
                  ))}
                </Table>
                <h3 className="sub">Scorecard weights</h3>
                <Table caption="Scorecard weights" head={['Factor', { num: 'Most points' }]}>
                  {p.scorecardWeights.map((w) => (
                    <tr key={w.factor}>
                      <td>{fieldLabel(w.factor)}</td>
                      <td className="num">{w.maxPoints}</td>
                    </tr>
                  ))}
                </Table>
              </Card>

              <Card title="Limit ladder and default rates">
                <Table
                  caption="Limit ladder"
                  head={[{ num: 'On time periods repaid' }, { num: 'Largest monthly rent' }]}
                >
                  {p.ladder.map((rung) => (
                    <tr key={rung.afterOnTimePeriods}>
                      <td className="num">
                        {rung.afterOnTimePeriods === 0
                          ? 'First plan'
                          : `${rung.afterOnTimePeriods} or more`}
                      </td>
                      <td className="num">{money(rung.capCents, { whole: true })}</td>
                    </tr>
                  ))}
                </Table>
                <h3 className="sub">Chance of going bad, by score</h3>
                <Table
                  caption="Probability of default by score band"
                  head={[{ num: 'Score' }, { num: 'Chance' }, { num: 'Plans behind it' }]}
                >
                  {p.pdBands.map((b) => (
                    <tr key={b.minScore}>
                      <td className="num">
                        {b.minScore} to {b.maxScore}
                      </td>
                      <td className="num">{percent(b.pdBps)}</td>
                      <td className="num">{b.plans.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </Table>
                <p className="muted small">
                  Calibrated on a simulated population, not real outcomes.
                </p>
              </Card>
            </div>

            <Card title="Integrity checks">
              <Table
                caption="Integrity flags and what each does"
                head={['Flag', 'Severity', 'What it does', 'Why']}
              >
                {p.integrityRules.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <div className="cell-main">{integrityLabel(r.code)}</div>
                      <div className="muted small mono">{r.code}</div>
                    </td>
                    <td>
                      <Pill
                        tone={
                          r.severity === 'CRITICAL' || r.severity === 'HIGH'
                            ? 'bad'
                            : r.severity === 'MEDIUM'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {words(r.severity)}
                      </Pill>
                    </td>
                    <td className="nowrap">{integrityAction(r.action)}</td>
                    <td>{r.why}</td>
                  </tr>
                ))}
              </Table>
            </Card>

            <div className="grid-2">
              {p.sections.slice(4, 6).map((s) => (
                <Section key={s.id} section={s} />
              ))}
            </div>

            <div className="grid-2">
              <Card title="Reserve by bucket">
                <Table
                  caption="Provision rates"
                  head={['Bucket', { num: 'Share of principal reserved' }]}
                >
                  {p.provisionRates.map((r) => (
                    <tr key={r.bucket}>
                      <td>
                        <StatusPill code={r.bucket} />
                      </td>
                      <td className="num">{percent(r.rateBps)}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
              <Card title="Bank return codes">
                <Table caption="Return codes" head={['Code', 'Meaning', 'Treated as']}>
                  {p.returnCodes.map((r) => (
                    <tr key={r.code}>
                      <td className="mono">{r.code}</td>
                      <td>{r.reason}</td>
                      <td>
                        <Pill
                          tone={
                            r.class === 'UNAUTHORIZED'
                              ? 'bad'
                              : r.class === 'HARD'
                                ? 'warn'
                                : 'neutral'
                          }
                        >
                          {r.class === 'RETRYABLE'
                            ? 'Retried'
                            : r.class === 'HARD'
                              ? 'Stops debits'
                              : 'Unauthorized'}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>

            <div className="grid-2">
              {p.sections.slice(6).map((s) => (
                <Section key={s.id} section={s} />
              ))}
            </div>

            <Card title="Monitoring rules" aside={`${p.monitoringRules.length} rules`}>
              <Table
                caption="Monitoring rules"
                head={['Rule', 'Category', 'What it checks', 'Behavior']}
              >
                {p.monitoringRules.map((r) => (
                  <tr key={r.type}>
                    <td className="mono">{r.type}</td>
                    <td>{words(r.category)}</td>
                    <td>{r.description}</td>
                    <td>
                      <div className="stack-tight">
                        <Pill tone={r.autoResolves ? 'info' : 'neutral'}>
                          {r.autoResolves ? 'Resolves itself' : 'Needs a person'}
                        </Pill>
                        {r.tripsCircuitBreaker ? <Pill tone="bad">Trips breaker</Pill> : null}
                      </div>
                    </td>
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

function Section({ section }: { section: PolicySection }) {
  return (
    <Card title={section.title}>
      {section.description ? <p className="muted">{section.description}</p> : null}
      {section.parameters.length === 0 ? (
        <p className="muted">Not in force under this policy version.</p>
      ) : (
        <Table caption={section.title} head={['Rule', { num: 'Value' }]}>
          {section.parameters.map((param) => (
            <tr key={param.key}>
              <td>
                {param.label}
                {param.note ? <div className="muted small">{param.note}</div> : null}
              </td>
              <td className="num cell-main">{byUnit(param.value, param.unit)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
