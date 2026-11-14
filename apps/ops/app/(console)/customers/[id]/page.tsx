'use client';

import {
  AuditLogPage,
  LandlordPayout,
  OperatorBusinessDetail,
  OperatorConnections,
  OperatorRentPlan,
  RentPlan,
  type GraduationOffer,
  type OperatorInstallment,
  type PassThroughPeriod,
  type PaymentHistory,
} from '@cashflow/shared';
import Link from 'next/link';
import { Fragment, use } from 'react';
import { z } from 'zod';

import { ConnectionsPanel } from '@/components/connections';
import { FreezePlan, LimitCard } from '@/components/controls';
import { NoticesCard } from '@/components/notices';
import { AlertsTable, AuditTable, ReasonAction } from '@/components/shared';
import {
  Card,
  Empty,
  Facts,
  Load,
  Notice,
  PageHead,
  Pill,
  StatusPill,
  Table,
} from '@/components/ui';
import { date, dateTime, days, money, month, percent, words } from '@/lib/format';
import { freezeReason, holdReason } from '@/lib/labels';
import { useIsAdmin } from '@/lib/session-context';
import { useApi } from '@/lib/use-api';

const Plans = z.array(OperatorRentPlan);

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const business = useApi(`businesses/${id}`, OperatorBusinessDetail);
  const plans = useApi(`businesses/${id}/rent-plans`, Plans);
  const audit = useApi(`audit-log?businessId=${id}&limit=50`, AuditLogPage);
  const connections = useApi(`businesses/${id}/connections`, OperatorConnections);
  const reloadAll = () => {
    business.reload();
    plans.reload();
    audit.reload();
  };

  return (
    <>
      <Load from={business} rows={10}>
        {(b) => <Profile detail={b} />}
      </Load>

      <Load from={business} rows={3}>
        {(b) => (b.limit ? <LimitCard limit={b.limit} onChanged={reloadAll} /> : null)}
      </Load>

      <Load from={plans} rows={8}>
        {(items) =>
          items.length === 0 ? (
            <Card title="Rent plans">
              <Empty title="No rent plan">This business has not started a plan.</Empty>
            </Card>
          ) : (
            <div className="stack">
              {items.map((plan) => (
                <PlanCard key={plan.id} plan={plan} onChanged={reloadAll} />
              ))}
            </div>
          )
        }
      </Load>

      <Load from={connections} rows={6}>
        {(c) => <ConnectionsPanel data={c} />}
      </Load>

      <Load from={business} rows={4}>
        {(b) => <NoticesCard notices={b.notices} />}
      </Load>

      <Load from={business} rows={4}>
        {(b) => (
          <Card title="Alerts" aside={`${b.alerts.length} about this business`} id="alerts">
            {b.alerts.length === 0 ? (
              <Empty title="No alerts about this business" />
            ) : (
              <AlertsTable alerts={b.alerts} caption="Alerts about this business" />
            )}
          </Card>
        )}
      </Load>

      <Card
        title="Audit trail"
        aside={<Link href={`/audit?businessId=${id}`}>Open in the audit log</Link>}
        id="audit"
      >
        <Load from={audit} rows={6}>
          {(page) => (
            <>
              <AuditTable events={page.items} caption="Audit trail of this business" />
              {page.nextCursor ? (
                <p className="muted small">
                  Showing the latest {page.items.length}. The audit log has the rest.
                </p>
              ) : null}
            </>
          )}
        </Load>
      </Card>
    </>
  );
}

function Profile({ detail }: { detail: OperatorBusinessDetail }) {
  const { business: b, identity } = detail;
  const openHits = detail.screenings.filter((s) => s.open);
  return (
    <>
      <PageHead
        back={{ href: '/customers', label: 'Customers' }}
        title={b.legalName}
        lead={b.dba && b.dba !== b.legalName ? `Trading as ${b.dba}` : undefined}
        actions={
          <>
            <StatusPill code={b.status} />
            <StatusPill code={identity.verificationStatus} />
          </>
        }
      />

      {openHits.length > 0 ? (
        <Notice tone="bad" title="This business has an open screening hit">
          <p>
            {openHits.map((h) => `${h.nameScreened} (${words(h.result)})`).join(', ')}. Work it in
            the <Link href="/screening">screening queue</Link>.
          </p>
        </Notice>
      ) : null}
      {detail.pendingLeaseChanges.length > 0 ? (
        <Notice tone="warn" title="A change to who gets paid is waiting">
          <p>
            {detail.pendingLeaseChanges.length === 1
              ? 'One lease change is pending'
              : `${detail.pendingLeaseChanges.length} lease changes are pending`}
            , taking effect {date(detail.pendingLeaseChanges[0]!.effectiveOn)} unless decided
            sooner. Decide it in <Link href="/lease-changes">lease changes</Link>.
          </p>
        </Notice>
      ) : null}

      <div className="grid-2">
        <Card title="Business">
          <Facts
            rows={[
              ['Industry', words(b.industry)],
              ['Founded', date(b.foundedOn)],
              ['Stated monthly revenue', money(b.statedMonthlyRevenueCents)],
              [
                'Address',
                `${b.address.line1}${b.address.line2 ? `, ${b.address.line2}` : ''}, ${b.address.city}, ${b.address.state} ${b.address.postalCode}`,
              ],
              ['Account owner', `${b.owner.fullName} (${b.owner.email})`],
              ['Joined', dateTime(b.createdAt)],
              [
                'Business id',
                <span key="id" className="mono">
                  {b.id}
                </span>,
              ],
            ]}
          />
          <h3 className="sub">Bank accounts</h3>
          {detail.bankLinks.length === 0 ? (
            <p className="muted">No bank account linked.</p>
          ) : (
            <ul className="plain">
              {detail.bankLinks.map((l) => (
                <li key={l.id}>
                  <StatusPill code={l.status} /> {l.institutionName}, account ending {l.accountMask}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Verification" aside={<StatusPill code={identity.verificationStatus} />}>
          <Facts
            rows={[
              ['Tax id', identity.taxIdLast4 ? `ends ${identity.taxIdLast4}` : 'Not given'],
              ['Checked', dateTime(identity.verificationCheckedAt)],
              ['Provider', identity.verificationProvider ?? '-'],
              [
                'Provider reasons',
                identity.verificationReasons.length > 0
                  ? identity.verificationReasons.map(words).join(', ')
                  : 'None',
              ],
            ]}
          />
          <Table
            caption="Beneficial owners"
            head={['Owner', 'Role', { num: 'Share' }, 'Verification']}
          >
            {identity.owners.map((o) => (
              <tr key={o.id}>
                <td className="cell-main">{o.fullName}</td>
                <td>{o.title}</td>
                <td className="num">{percent(o.ownershipBps)}</td>
                <td>
                  <StatusPill code={o.verificationStatus} />
                </td>
              </tr>
            ))}
          </Table>
          <h3 className="sub">Screenings in force</h3>
          {detail.screenings.length === 0 ? (
            <p className="muted">Nothing has been screened yet.</p>
          ) : (
            <Table caption="Current screenings" head={['Party', 'Name', 'Result', 'Screened']}>
              {detail.screenings.map((s) => (
                <tr key={s.id}>
                  <td>{words(s.partyType)}</td>
                  <td>{s.nameScreened}</td>
                  <td>
                    <StatusPill code={s.result} />{' '}
                    {s.open ? (
                      <Pill tone="bad">Open</Pill>
                    ) : s.clearedAt ? (
                      <Pill>Cleared</Pill>
                    ) : null}
                  </td>
                  <td className="nowrap">{date(s.screenedAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Applications and decisions" aside={`${detail.applications.length} on record`}>
        {detail.applications.length === 0 ? (
          <Empty title="No application" />
        ) : (
          <Table
            caption="Applications"
            head={[
              'Submitted',
              'Status',
              { num: 'Rent asked' },
              'Current decision',
              { num: 'Limit' },
              { num: 'Fee' },
              'Score',
              '',
            ]}
          >
            {detail.applications.map((a) => {
              const d = a.currentDecision;
              return (
                <tr key={a.id}>
                  <td className="nowrap">
                    {a.submittedAt ? date(a.submittedAt) : 'Not submitted'}
                  </td>
                  <td>
                    <StatusPill code={a.status} />
                  </td>
                  <td className="num">{money(a.requestedMonthlyRentCents)}</td>
                  <td>
                    {d ? (
                      <>
                        {d.kind === 'REVIEW'
                          ? `Review by ${d.reviewer ?? 'a reviewer'}`
                          : words(d.kind)}
                        {d.isOverride ? (
                          <>
                            {' '}
                            <Pill tone="warn">Override</Pill>
                          </>
                        ) : null}
                        <div className="muted small">
                          {date(d.decidedAt)}, {d.policyVersion}
                        </div>
                      </>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="num">
                    {d && d.outcome === 'APPROVED' ? money(d.approvedMonthlyLimitCents) : '-'}
                  </td>
                  <td className="num">{d && d.outcome === 'APPROVED' ? percent(d.feeBps) : '-'}</td>
                  <td className="nowrap">
                    {d?.score ?? '-'}
                    {d?.grade ? ` (${d.grade})` : ''}
                  </td>
                  <td>
                    <Link href={`/reviews/${a.id}`}>Open</Link>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Leases" aside={`${detail.leases.length} on record`}>
        {detail.leases.length === 0 ? (
          <Empty title="No lease" />
        ) : (
          <Table
            caption="Leases"
            head={['Landlord', 'Property', { num: 'Rent' }, 'Due', 'Pays to', 'Status']}
          >
            {detail.leases.map((l) => (
              <tr key={l.id}>
                <td>
                  <div className="cell-main">{l.landlordName}</div>
                  <div className="muted small">{l.landlordEmail}</div>
                </td>
                <td>
                  {l.propertyAddress.line1}, {l.propertyAddress.city}
                </td>
                <td className="num">{money(l.monthlyRentCents)}</td>
                <td className="nowrap">Day {l.dueDayOfMonth}</td>
                <td>
                  {l.accountHolderName}
                  <div className="muted small">
                    Routing {l.routingNumber}, account ending {l.accountNumberLast4}
                  </div>
                </td>
                <td>
                  <StatusPill code={l.status} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <PaymentHistoryCard history={detail.paymentHistory} offers={detail.graduationOffers} />
    </>
  );
}

/** Every month of rent through CashFlow, and any offers to move off the pass-through plan. */
function PaymentHistoryCard({
  history,
  offers,
}: {
  history: PaymentHistory | null;
  offers: GraduationOffer[];
}) {
  return (
    <Card
      title="Payment history"
      aside={history ? `As of ${date(history.asOf)}, last ${history.lookbackMonths} months` : null}
    >
      {!history || history.months.length === 0 ? (
        <Empty title="No months with an outcome yet" />
      ) : (
        <>
          <Facts
            rows={[
              ['On time', history.summary.onTimeMonths],
              ['Late', history.summary.lateMonths],
              ['Missed', history.summary.missedMonths],
              ['Current on-time streak', history.summary.currentOnTimeStreak],
              history.monthsUntilReview !== null
                ? ['On-time months until review', history.monthsUntilReview]
                : null,
              history.summary.lastMissedPeriod
                ? ['Last missed', month(history.summary.lastMissedPeriod)]
                : null,
            ]}
          />
          <Table caption="Months, newest first" head={['Month', 'Due', 'Outcome', 'Plan kind']}>
            {history.months.map((m) => (
              <tr key={`${m.rentPlanId}-${m.periodMonth}`}>
                <td className="cell-main nowrap">{month(m.periodMonth)}</td>
                <td className="nowrap">{date(m.dueDate)}</td>
                <td>
                  <StatusPill code={m.outcome} />
                </td>
                <td>{planKind(m.kind)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <h3 className="sub">Graduation offers</h3>
      {offers.length === 0 ? (
        <p className="muted">No offer to move to a financed plan.</p>
      ) : (
        <Table
          caption="Graduation offers, newest first"
          head={['Status', 'Offered', 'Expires', { num: 'Fee' }, { num: 'Limit' }, 'Effective']}
        >
          {offers.map((o) => (
            <tr key={o.id}>
              <td>
                <StatusPill code={o.status} />
              </td>
              <td className="nowrap">{date(o.offeredOn)}</td>
              <td className="nowrap">{date(o.expiresOn)}</td>
              <td className="num">
                {percent(o.feeBps)}
                <div className="muted small">{money(o.feeCentsPerMonth)} a month</div>
              </td>
              <td className="num">{money(o.approvedMonthlyLimitCents)}</td>
              <td className="nowrap">{o.effectivePeriod ? month(o.effectivePeriod) : '-'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function planKind(kind: OperatorRentPlan['kind']): string {
  return kind === 'PASS_THROUGH' ? 'Pass-through' : 'Financed';
}

/** The months of a pass-through plan: collected from the business, then paid to the landlord. */
function PassThroughTable({ periods }: { periods: PassThroughPeriod[] }) {
  return (
    <div>
      <h3 className="sub">Pass-through months</h3>
      {periods.length === 0 ? (
        <p className="muted">No month generated yet.</p>
      ) : (
        <Table
          caption="Pass-through months"
          head={[
            'Month',
            'Due',
            { num: 'Amount' },
            'Status',
            'Collected',
            'Paid to landlord',
            'Missed reason',
          ]}
        >
          {periods.map((p) => (
            <tr key={p.id}>
              <td className="cell-main nowrap">{month(p.periodMonth)}</td>
              <td className="nowrap">
                {date(p.dueDate)}
                <div className="muted small">Collect from {date(p.collectOn)}</div>
              </td>
              <td className="num">{money(p.amountCents)}</td>
              <td>
                <StatusPill code={p.status} />
              </td>
              <td className="nowrap">{date(p.collectedOn)}</td>
              <td className="nowrap">{date(p.paidOn)}</td>
              <td>
                {p.missedReason ? words(p.missedReason) : null}
                {p.returnCode ? (
                  <div className="muted small">
                    Return code <span className="mono">{p.returnCode}</span>
                  </div>
                ) : null}
                {p.heldReason ? (
                  <div className="muted small">Held: {words(p.heldReason).toLowerCase()}</div>
                ) : null}
                {!p.missedReason && !p.returnCode && !p.heldReason ? (
                  <span className="muted">-</span>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function PlanCard({ plan, onChanged }: { plan: OperatorRentPlan; onChanged: () => void }) {
  const isAdmin = useIsAdmin();
  const frozen = plan.advanceFrozenAt !== null;
  const adminFreeze = plan.advanceFrozenReason === 'OPERATOR_HOLD';
  const held = plan.payouts.filter((p) => p.status === 'HELD');
  const passThrough = plan.kind === 'PASS_THROUGH';
  return (
    <Card
      title={`Rent plan: ${money(plan.monthlyRentCents)} a month to ${plan.landlordName}`}
      aside={
        <>
          <Pill tone={passThrough ? 'info' : 'neutral'}>{planKind(plan.kind)}</Pill>
          <StatusPill code={plan.status} />
          <StatusPill code={plan.delinquencyStatus} />
          {frozen ? <Pill tone="warn">Frozen</Pill> : null}
        </>
      }
    >
      <Facts
        rows={[
          ['Standing', <StatusPill key="s" code={plan.delinquencyStatus} />],
          ['Days past due', plan.daysPastDue === 0 ? 'None' : days(plan.daysPastDue)],
          ['Past due', money(plan.pastDueCents)],
          ['Kind', planKind(plan.kind)],
          ['Fee', passThrough ? 'None' : percent(plan.feeBps)],
          passThrough ? null : ['Installments a month', plan.installmentsPerMonth],
          ['Rent due', `Day ${plan.dueDayOfMonth}`],
          ['Started', date(plan.createdAt)],
          plan.closedAt
            ? [
                'Closed',
                `${date(plan.closedAt)}${plan.closedReason ? `, ${words(plan.closedReason).toLowerCase()}` : ''}`,
              ]
            : null,
          plan.pendingRentCents !== null
            ? ['Rent increase waiting', money(plan.pendingRentCents)]
            : null,
        ]}
      />

      {plan.needsPayment ? (
        <Notice tone="bad" title="Automatic debits have stopped">
          <p>
            The bank link is gone or was disabled by a return, or an installment has used all its
            attempts. Only a payment by the owner clears the balance.
          </p>
        </Notice>
      ) : null}

      {frozen ? (
        <Notice tone="warn" title={`Frozen since ${date(plan.advanceFrozenAt)}`}>
          <p>
            {freezeReason(plan.advanceFrozenReason)}. No new rent period is paid to the landlord
            until the freeze is released. Rent already fronted is still collected.
          </p>
          {plan.status !== 'CLOSED' ? (
            <ReasonAction
              path={`rent-plans/${plan.id}/release-freeze`}
              schema={RentPlan}
              body={(reason) => ({ reason })}
              trigger="Release the freeze"
              submit="Release"
              label="Why it is safe to resume"
              hint="Recorded in the audit log under your name."
              onDone={onChanged}
              disabledReason={
                adminFreeze && !isAdmin
                  ? 'An admin froze this plan by hand. Releasing it needs the admin role.'
                  : undefined
              }
            >
              <p>
                A payout held by the freeze is paid on the next job run if it is still inside its
                release window. Otherwise it is cancelled.
              </p>
            </ReasonAction>
          ) : null}
        </Notice>
      ) : null}

      {!frozen && plan.status !== 'CLOSED' ? (
        <FreezePlan planId={plan.id} onChanged={onChanged} />
      ) : null}

      {held.length > 0 ? (
        <Notice
          tone="warn"
          title={held.length === 1 ? 'A payout is on hold' : `${held.length} payouts are on hold`}
        >
          <ul className="plain">
            {held.map((p) => (
              <li key={p.id}>
                {month(p.periodMonth)}, {money(p.amountCents)}: {holdReason(p.heldReason)}.
                {p.releaseBy ? ` It can still be paid until ${date(p.releaseBy)}.` : ''}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {passThrough ? <PassThroughTable periods={plan.passThroughPeriods} /> : null}

      {passThrough && plan.payouts.length === 0 ? null : (
        <div>
          <h3 className="sub">Payouts to the landlord</h3>
          <Table
            caption="Landlord payouts"
            head={[
              'Period',
              'Scheduled',
              { num: 'Amount' },
              'Status',
              'Hold or failure',
              'Paid',
              '',
            ]}
          >
            {plan.payouts.map((p) => (
              <tr key={p.id}>
                <td className="cell-main nowrap">{month(p.periodMonth)}</td>
                <td className="nowrap">{date(p.scheduledFor)}</td>
                <td className="num">{money(p.amountCents)}</td>
                <td>
                  <StatusPill code={p.status} />
                </td>
                <td>
                  {p.heldReason ? (
                    <div>
                      {holdReason(p.heldReason)}
                      {p.releaseBy ? (
                        <span className="muted small"> Release by {date(p.releaseBy)}.</span>
                      ) : null}
                    </div>
                  ) : null}
                  {p.returnCode ? (
                    <div>
                      Returned by the bank, code <span className="mono">{p.returnCode}</span>
                    </div>
                  ) : null}
                  {p.failureReason ? <div className="small">{p.failureReason}</div> : null}
                  {p.resendCount > 0 ? (
                    <div className="muted small">Sent again {p.resendCount} time(s)</div>
                  ) : null}
                  {!p.heldReason && !p.returnCode && !p.failureReason ? (
                    <span className="muted">-</span>
                  ) : null}
                </td>
                <td className="nowrap">{p.paidAt ? date(p.paidAt) : '-'}</td>
                <td>
                  {p.canResend ? (
                    <ReasonAction
                      path={`payouts/${p.id}/resend`}
                      schema={LandlordPayout}
                      body={(reason) => ({ reason })}
                      trigger="Send again"
                      submit="Send the payout again"
                      label="What was corrected, and how you confirmed it"
                      hint="The landlord's details must have been corrected and the correction applied."
                      onDone={onChanged}
                    >
                      <p>
                        This payout came back from the landlord&apos;s bank. Sending it again pays{' '}
                        {money(p.amountCents)} to the account now on the lease.
                      </p>
                    </ReasonAction>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {passThrough && plan.installments.length === 0 ? null : (
        <div>
          <h3 className="sub">Installments and debits</h3>
          <Table
            caption="Installments with their debits"
            head={['Period', 'Due', { num: 'Amount' }, 'Status', 'Attempts', 'Paid', 'Notes']}
          >
            {plan.installments.map((i) => (
              <InstallmentRows key={i.id} installment={i} />
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

function InstallmentRows({ installment: i }: { installment: OperatorInstallment }) {
  return (
    <Fragment>
      <tr>
        <td className="cell-main nowrap">
          {month(i.periodMonth)} #{i.sequence}
        </td>
        <td className="nowrap">{date(i.dueDate)}</td>
        <td className="num">
          {money(i.totalCents)}
          <div className="muted small">{money(i.feeCents)} fee</div>
        </td>
        <td>
          <StatusPill code={i.status} />
        </td>
        <td className="nowrap">
          {i.attempts}
          {i.maxAttempts !== null ? ` of ${i.maxAttempts}` : ''}
          {i.lastAttemptOn ? <div className="muted small">Last {date(i.lastAttemptOn)}</div> : null}
        </td>
        <td className="nowrap">{i.paidAt ? date(i.paidAt) : '-'}</td>
        <td>
          {i.chargedOffAt ? <div>Written off {date(i.chargedOffAt)}</div> : null}
          {i.collectionSkipReason ? (
            <div>
              Debit put off {date(i.collectionSkippedOn)}:{' '}
              {words(i.collectionSkipReason).toLowerCase()}
            </div>
          ) : null}
          {!i.chargedOffAt && !i.collectionSkipReason ? <span className="muted">-</span> : null}
        </td>
      </tr>
      {i.repayments.map((r) => (
        <tr key={r.id} className="sub-row">
          <td />
          <td className="nowrap">{dateTime(r.createdAt)}</td>
          <td className="num">{money(r.amountCents)}</td>
          <td>
            <StatusPill code={r.status} />
          </td>
          <td colSpan={3}>
            {r.recovery ? 'Recovery on a written off balance. ' : ''}
            {r.manual ? 'Paid by the owner. ' : 'Automatic debit. '}
            {r.returnCode ? (
              <>
                Return code <span className="mono">{r.returnCode}</span>: {r.returnReason}
                {r.returnClass ? ` (${words(r.returnClass).toLowerCase()})` : ''}
                {r.returnedAt ? `, returned ${date(r.returnedAt)}` : ''}.{' '}
              </>
            ) : null}
            {r.failureReason && !r.returnCode ? r.failureReason : ''}
          </td>
        </tr>
      ))}
    </Fragment>
  );
}
