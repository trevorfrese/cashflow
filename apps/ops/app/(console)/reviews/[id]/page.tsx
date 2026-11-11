'use client';

import {
  OperatorApplicationDetail,
  RecordReviewResponse,
  ReviewReasonCode,
  type OperatorDecision,
  type RecordReviewRequest,
} from '@cashflow/shared';
import Link from 'next/link';
import { use, useState } from 'react';

import { AuditTable } from '@/components/shared';
import {
  Button,
  Card,
  Empty,
  Facts,
  Field,
  Load,
  Notice,
  PageHead,
  Pill,
  Refusal,
  StatusPill,
  Table,
} from '@/components/ui';
import {
  date,
  dateTime,
  days,
  deadline,
  dollarsInput,
  money,
  parseDollars,
  parsePercent,
  percent,
  percentInput,
  words,
} from '@/lib/format';
import {
  feeDriver,
  integrityAction,
  integrityLabel,
  limitCap,
  REVIEW_REASONS,
  triggerLabel,
} from '@/lib/labels';
import { useAction, useApi } from '@/lib/use-api';

type Detail = OperatorApplicationDetail;
type Decision = RecordReviewRequest['decision'];

const OUTCOME_OF: Record<Decision, string> = {
  APPROVE: 'APPROVED',
  DECLINE: 'DECLINED',
  REQUEST_INFO: 'NEEDS_INFO',
};

export default function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi(`applications/${id}`, OperatorApplicationDetail);
  return (
    <Load from={detail} rows={10}>
      {(d) => <Review detail={d} reload={detail.reload} />}
    </Load>
  );
}

function Review({ detail, reload }: { detail: Detail; reload: () => void }) {
  const { application: a, current } = detail;
  const due = deadline(detail.decisionDueOn);
  const waiting = a.status === 'IN_REVIEW';
  return (
    <>
      <PageHead
        back={{ href: '/reviews', label: 'Review queue' }}
        title={a.businessName}
        lead={
          <>
            Application for {money(a.requestedMonthlyRentCents)} of monthly rent.{' '}
            <Link href={`/customers/${a.businessId}`}>Open the customer</Link>
          </>
        }
        actions={<StatusPill code={a.status} />}
      />

      {waiting && due && due.tone !== 'neutral' ? (
        <Notice
          tone={due.tone === 'bad' ? 'bad' : 'warn'}
          title={
            due.daysLeft < 0
              ? `The answer was due ${date(detail.decisionDueOn)}: ${due.label}`
              : `The answer is due ${date(detail.decisionDueOn)}: ${due.label.toLowerCase()}`
          }
        >
          <p>
            An applicant must be told the outcome within 30 days of a complete application. This one
            has waited {days(detail.ageDays)}.
          </p>
        </Notice>
      ) : null}

      <div className="split">
        <div className="stack">
          <Card title="Application">
            <Facts
              rows={[
                ['Rent requested', money(a.requestedMonthlyRentCents)],
                ['Stated monthly revenue', money(a.statedMonthlyRevenueCents)],
                ['Time in business', `${a.timeInBusinessMonths} months`],
                ['Industry', words(a.industry)],
                ['Submitted', dateTime(a.submittedAt)],
                ['Waiting', days(detail.ageDays)],
                ['Answer due', date(detail.decisionDueOn)],
              ]}
            />
          </Card>

          {current ? (
            <DecisionCards decision={current} />
          ) : (
            <Empty title="No decision yet">This application has not been submitted.</Empty>
          )}

          <IdentityCard detail={detail} />

          <Card title="Decision history" aside={`${detail.history.length} recorded`}>
            <Table
              caption="Every decision on this application, newest first"
              head={[
                'Decided',
                'By',
                'Outcome',
                { num: 'Limit' },
                { num: 'Fee' },
                'Score',
                'Policy',
              ]}
            >
              {detail.history.map((h) => (
                <tr key={h.id}>
                  <td className="nowrap">{dateTime(h.decidedAt)}</td>
                  <td>
                    {h.kind === 'REVIEW' ? (h.reviewer ?? 'Reviewer') : words(h.kind)}
                    {h.reviewPeriod ? <div className="muted small">{h.reviewPeriod}</div> : null}
                  </td>
                  <td>
                    <StatusPill code={h.outcome} />{' '}
                    {h.isOverride ? <Pill tone="warn">Override</Pill> : null}{' '}
                    {h.supersededAt === null ? <Pill tone="info">Current</Pill> : null}
                  </td>
                  <td className="num">{money(h.approvedMonthlyLimitCents)}</td>
                  <td className="num">{percent(h.feeBps)}</td>
                  <td className="nowrap">
                    {h.score ?? '-'}
                    {h.grade ? ` (${h.grade})` : ''}
                  </td>
                  <td className="mono">{h.policyVersion}</td>
                </tr>
              ))}
            </Table>
            {detail.reviews.length > 0 ? (
              <>
                <h3 className="sub">Reviews</h3>
                <Table
                  caption="Reviews recorded on this application"
                  head={['When', 'Reviewer', 'Decision', 'Reason codes', 'Internal notes']}
                >
                  {detail.reviews.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{dateTime(r.createdAt)}</td>
                      <td>{r.reviewer}</td>
                      <td>
                        {words(r.decision)}{' '}
                        {r.isOverride ? <Pill tone="warn">Override</Pill> : null}
                      </td>
                      <td>
                        {r.reasonCodes.length === 0
                          ? 'None'
                          : r.reasonCodes
                              .map((c) => REVIEW_REASONS[c as ReviewReasonCode] ?? words(c))
                              .join('; ')}
                      </td>
                      <td>{r.notes ?? <span className="muted">None</span>}</td>
                    </tr>
                  ))}
                </Table>
              </>
            ) : null}
          </Card>

          <Card title="Audit trail">
            <AuditTable events={detail.auditEvents} showSubject={false} />
          </Card>
        </div>

        <div className="split-side">
          <ReviewForm detail={detail} onRecorded={reload} />
        </div>
      </div>
    </>
  );
}

function DecisionCards({ decision: d }: { decision: OperatorDecision }) {
  const rec = d.recommendation;
  const cf = d.cashFlow;
  return (
    <>
      <Card
        title="What the engine recommends"
        tone="gold"
        aside={<span className="mono">{d.policyVersion}</span>}
      >
        <Facts
          rows={[
            ['Recommendation', <StatusPill key="o" code={rec.outcome} />],
            ['Monthly limit', money(rec.approvedMonthlyLimitCents)],
            ['Fee per period', percent(rec.feeBps)],
            ['Score', d.score === null ? 'Not scored' : `${d.score} of 100`],
            ['Grade', d.grade ?? '-'],
            ['Installments a month', d.recommendedInstallmentsPerMonth ?? '-'],
          ]}
        />
        <div>
          <h3 className="sub">Why it was sent to a person</h3>
          {d.referTriggers.length === 0 ? (
            <p className="muted">
              {d.kind === 'REVIEW'
                ? 'A reviewer has since decided this application.'
                : 'The engine decided this application on its own.'}
            </p>
          ) : (
            <ul className="plain">
              {d.referTriggers.map((t) => (
                <li key={t}>
                  <Pill tone="warn">Refer</Pill> {triggerLabel(t)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card title="Integrity flags" aside={`${d.integrityFlags.length} raised`}>
        {d.integrityFlags.length === 0 ? (
          <p className="muted">The integrity checks raised nothing.</p>
        ) : (
          <Table caption="Integrity flags" head={['Flag', 'Severity', 'What it does', 'Detail']}>
            {d.integrityFlags.map((f) => (
              <tr key={f.code}>
                <td>
                  <div className="cell-main">{integrityLabel(f.code)}</div>
                  <div className="muted small mono">{f.code}</div>
                </td>
                <td>
                  <Pill
                    tone={
                      f.severity === 'CRITICAL' || f.severity === 'HIGH'
                        ? 'bad'
                        : f.severity === 'MEDIUM'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {words(f.severity)}
                  </Pill>
                </td>
                <td>{integrityAction(f.action)}</td>
                <td>{f.detail}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Score factors"
        aside={d.score !== null ? `${d.score} of 100, grade ${d.grade ?? '-'}` : 'Not scored'}
      >
        {d.factors ? (
          <>
            {!d.factorsMatchScore ? (
              <Notice tone="warn" title="These points are a guide">
                <p>
                  The points are rebuilt from the stored cash flow and do not add up to the stored
                  score exactly. The score above is the one the decision used.
                </p>
              </Notice>
            ) : null}
            <Table
              caption="Scorecard factors and points"
              head={['Factor', { num: 'Points' }, '', 'Finding']}
            >
              {d.factors.map((f) => (
                <tr key={f.code}>
                  <td className="cell-main">{f.label}</td>
                  <td className="num">
                    {f.points} of {f.maxPoints}
                  </td>
                  <td>
                    <span
                      className="points"
                      role="img"
                      aria-label={`${f.points} of ${f.maxPoints} points`}
                    >
                      <span
                        style={{
                          width: `${f.maxPoints > 0 ? (f.points / f.maxPoints) * 100 : 0}%`,
                        }}
                      />
                    </span>
                  </td>
                  <td>
                    <Pill
                      tone={
                        f.impact === 'POSITIVE'
                          ? 'good'
                          : f.impact === 'NEGATIVE'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {f.impact === 'POSITIVE'
                        ? 'Helps'
                        : f.impact === 'NEGATIVE'
                          ? 'Hurts'
                          : 'Neutral'}
                    </Pill>{' '}
                    {f.message}
                  </td>
                </tr>
              ))}
            </Table>
          </>
        ) : (
          <p className="muted">There was no cash flow to score, so there are no factor points.</p>
        )}
        <div>
          <h3 className="sub">Reasons on the decision</h3>
          <ul className="plain">
            {d.reasons.map((r, i) => (
              <li key={`${r.code}-${i}`}>
                <Pill
                  tone={
                    r.impact === 'POSITIVE' ? 'good' : r.impact === 'NEGATIVE' ? 'bad' : 'neutral'
                  }
                >
                  {r.impact === 'POSITIVE' ? 'Helps' : r.impact === 'NEGATIVE' ? 'Hurts' : 'Info'}
                </Pill>
                <span>{r.message}</span>
                <span className="muted small mono">{r.code}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Expected loss and fee">
          {d.pricing ? (
            <>
              <Facts
                wide
                rows={[
                  ['Score band', d.pricing.scoreBand],
                  ['Chance of going bad', percent(d.pricing.pdBps)],
                  [
                    'Loss if it does',
                    `${percent(d.pricing.lossGivenDefaultBps)} of a month of rent`,
                  ],
                  ['Expected loss per period', percent(d.pricing.expectedLossBps)],
                  ['Cost of funds', percent(d.pricing.costOfFundsBps)],
                  ['Servicing', percent(d.pricing.servicingBps)],
                  ['Target margin', percent(d.pricing.targetMarginBps)],
                  ['Fee needed', percent(d.pricing.requiredBps)],
                  ['Grade floor', percent(d.pricing.gradeFloorBps)],
                  ['Minimum fee, as a rate', percent(d.pricing.minFeeBps)],
                  [
                    'Fee quoted',
                    `${percent(d.pricing.feeBps)} (${money(d.pricing.feeCents)} a period)`,
                  ],
                ]}
              />
              <p className="muted small">
                Set by {feeDriver(d.pricing.driver)}. The cap is {percent(d.pricing.maxFeeBps)}
                {d.pricing.withinCap ? '.' : ', and the fee needed is above it.'}
              </p>
            </>
          ) : (
            <p className="muted">No fee build-up was stored with this decision.</p>
          )}
        </Card>
        <Card title="Limit and funding">
          {d.exposure ? (
            <>
              <Facts
                wide
                rows={[
                  ['Limit', money(d.exposure.limitCents)],
                  ['Set by', limitCap(d.exposure.binding)],
                  ...Object.entries(d.exposure.caps).map(
                    ([cap, cents]) =>
                      [`Cap: ${limitCap(cap).toLowerCase()}`, money(Math.round(cents))] as [
                        string,
                        string,
                      ],
                  ),
                ]}
              />
            </>
          ) : (
            <p className="muted">No limit calculation was stored with this decision.</p>
          )}
          {d.funding ? (
            <p className="small">
              Funding check: {d.funding.ok ? 'the pool can take this plan' : 'the plan would wait'}
              {d.funding.blockers.length > 0
                ? ` (${d.funding.blockers.map(words).join(', ')})`
                : ''}
              . Pool utilization with it {percent(d.funding.utilizationBps)}, industry share{' '}
              {percent(d.funding.industryShareBps)}.
            </p>
          ) : null}
        </Card>
      </div>

      <Card title="Cash flow" aside={cf ? `As of ${date(cf.asOf)}` : undefined}>
        {cf ? (
          <Facts
            rows={[
              ['Verified monthly revenue', money(cf.verifiedMonthlyRevenueCents)],
              ['Stated against verified', percent(cf.statedRevenueVarianceBps)],
              ['Months of history', cf.monthsOfHistory],
              ['Rent to revenue', percent(cf.rentToRevenueBps)],
              ['Coverage of rent and fee', `${(cf.rentCoverageRatio / 100).toFixed(2)}x`],
              ['Monthly net cash flow', money(cf.monthlyNetCashFlowCents)],
              ['Operating outflows', money(cf.monthlyOperatingOutflowsCents)],
              ['Debt service', money(cf.monthlyDebtServiceCents)],
              ['Debt to revenue', percent(cf.debtToRevenueBps)],
              ['Rent seen in the account', money(cf.observedRentCents)],
              ['Current balance', money(cf.currentBalanceCents)],
              ['Average balance, 90 days', money(cf.avgDailyBalance90Cents)],
              ['Lowest balance, 90 days', money(cf.minBalance90Cents)],
              ['Days of cash on hand', cf.daysOfCashOnHand ?? '-'],
              ['Days overdrawn, 90 days', cf.negativeBalanceDays90],
              ['Returned items, 90 days', cf.nsfCount90],
              ['Revenue growth', percent(cf.revenueGrowthBps)],
              ['Revenue variation', percent(cf.revenueVolatilityBps)],
            ]}
          />
        ) : (
          <p className="muted">No bank data was available for this decision.</p>
        )}
      </Card>
    </>
  );
}

function IdentityCard({ detail }: { detail: Detail }) {
  const { identity, openScreeningHits } = detail;
  return (
    <Card title="Identity and screening" aside={<StatusPill code={identity.verificationStatus} />}>
      {openScreeningHits.length > 0 ? (
        <Notice tone="bad" title="An open screening hit blocks approval">
          <p>
            {openScreeningHits.map((h) => `${h.nameScreened} (${words(h.result)})`).join(', ')}.
            Clear it in the <Link href="/screening">screening queue</Link> before approving.
          </p>
        </Notice>
      ) : (
        <p>No open screening hits on the business, its owners, or its landlords.</p>
      )}
      <Facts
        rows={[
          ['Business', identity.legalName],
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
      <Table caption="Beneficial owners" head={['Owner', 'Role', { num: 'Share' }, 'Verification']}>
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
    </Card>
  );
}

function ReviewForm({ detail, onRecorded }: { detail: Detail; onRecorded: () => void }) {
  const { application: a, current, identity, openScreeningHits } = detail;
  const rec = current?.recommendation ?? null;
  const reviewable = (a.status === 'IN_REVIEW' || a.status === 'DECLINED') && current !== null;

  const [decision, setDecision] = useState<Decision | null>(null);
  const [limit, setLimit] = useState(dollarsInput(rec?.approvedMonthlyLimitCents));
  const [fee, setFee] = useState(percentInput(rec?.feeBps));
  const [codes, setCodes] = useState<ReviewReasonCode[]>([]);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);

  const review = useAction<RecordReviewRequest, RecordReviewResponse>(
    `applications/${a.id}/review`,
    RecordReviewResponse,
    (result) => {
      setRecorded(
        `${words(result.review.decision)} recorded${result.review.isOverride ? ' as an override' : ''}.`,
      );
      onRecorded();
    },
  );

  if (!reviewable || !rec) {
    return (
      <Card title="Decision">
        {recorded ? <Notice tone="good" title={recorded} /> : null}
        <p>
          This application is <strong>{words(a.status).toLowerCase()}</strong>. Only applications in
          review, or declined ones up for reconsideration, can be decided here.
        </p>
      </Card>
    );
  }

  const limitCents = parseDollars(limit);
  const feeBps = parsePercent(fee);
  const approving = decision === 'APPROVE';
  const termsDiffer =
    approving && (limitCents !== rec.approvedMonthlyLimitCents || feeBps !== rec.feeBps);
  const isOverride = decision !== null && (OUTCOME_OF[decision] !== rec.outcome || termsDiffer);

  const problems: string[] = [];
  if (decision === null) problems.push('Choose a decision.');
  if (approving) {
    if (limitCents === null || limitCents <= 0)
      problems.push('Enter the monthly limit in dollars.');
    else if (limitCents > a.requestedMonthlyRentCents)
      problems.push(
        `The limit cannot be above the ${money(a.requestedMonthlyRentCents)} requested.`,
      );
    if (feeBps === null || feeBps <= 0) problems.push('Enter the fee as a percentage.');
  }
  if (
    approving &&
    identity.verificationStatus !== 'VERIFIED' &&
    !codes.includes('IDENTITY_VERIFIED')
  )
    problems.push(
      `The business is not verified. Tick "${REVIEW_REASONS.IDENTITY_VERIFIED}" if you verified it another way.`,
    );
  if (decision === 'REQUEST_INFO' && message.trim().length === 0)
    problems.push('Write the message the applicant will see.');
  if (isOverride && codes.length === 0)
    problems.push('An override needs at least one reason code.');
  if (isOverride && !confirmed) problems.push('Confirm the override.');

  const toggle = (code: ReviewReasonCode) =>
    setCodes((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));

  function submit() {
    if (decision === null || problems.length > 0) return;
    void review.run({
      decision,
      reasonCodes: codes,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(decision === 'REQUEST_INFO' ? { applicantMessage: message.trim() } : {}),
      // Terms are sent only when they differ from the engine's, which is what makes them an override.
      ...(approving && termsDiffer && limitCents !== null
        ? { approvedMonthlyLimitCents: limitCents }
        : {}),
      ...(approving && termsDiffer && feeBps !== null ? { feeBps } : {}),
    });
  }

  return (
    <Card title={a.status === 'DECLINED' ? 'Reconsider this decline' : 'Record a decision'}>
      {recorded ? <Notice tone="good" title={recorded} /> : null}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset>
          <legend className="legend">Decision</legend>
          {(
            [
              ['APPROVE', 'Approve'],
              ['DECLINE', 'Decline'],
              ['REQUEST_INFO', 'Request information'],
            ] as Array<[Decision, string]>
          ).map(([value, label]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="decision"
                value={value}
                checked={decision === value}
                onChange={() => {
                  setDecision(value);
                  setConfirmed(false);
                  review.reset();
                }}
              />
              <span>
                <strong>{label}</strong>
                {OUTCOME_OF[value] === rec.outcome ? (
                  <span className="muted small"> (the engine&apos;s recommendation)</span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>

        {approving ? (
          <>
            {openScreeningHits.length > 0 ? (
              <Notice tone="bad" title="An open screening hit blocks approval">
                <p>
                  Clear it in the <Link href="/screening">screening queue</Link> first. The API will
                  refuse an approval until then.
                </p>
              </Notice>
            ) : null}
            {identity.verificationStatus !== 'VERIFIED' ? (
              <Notice tone="warn" title="The business is not verified">
                <p>
                  The identity provider left it {words(identity.verificationStatus).toLowerCase()}.
                  Approving needs the reason code &quot;{REVIEW_REASONS.IDENTITY_VERIFIED}&quot;,
                  which records that you verified it another way.
                </p>
              </Notice>
            ) : null}
            <div className="grid-2">
              <Field
                label="Monthly limit, dollars"
                htmlFor="limit"
                required
                hint={`Engine: ${money(rec.approvedMonthlyLimitCents)}. At most ${money(a.requestedMonthlyRentCents)}.`}
              >
                <input
                  id="limit"
                  type="text"
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => {
                    setLimit(e.target.value);
                    setConfirmed(false);
                  }}
                  aria-describedby="limit-hint"
                />
              </Field>
              <Field
                label="Fee per period, percent"
                htmlFor="fee"
                required
                hint={`Engine: ${percent(rec.feeBps)}.`}
              >
                <input
                  id="fee"
                  type="text"
                  inputMode="decimal"
                  value={fee}
                  onChange={(e) => {
                    setFee(e.target.value);
                    setConfirmed(false);
                  }}
                  aria-describedby="fee-hint"
                />
              </Field>
            </div>
          </>
        ) : null}

        {decision === 'REQUEST_INFO' ? (
          <Field
            label="Message to the applicant"
            htmlFor="applicant-message"
            required
            hint="The applicant sees this exactly as written. Say what to provide."
          >
            <textarea
              id="applicant-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              aria-describedby="applicant-message-hint"
            />
          </Field>
        ) : null}

        <fieldset>
          <legend className="legend">
            Reason codes{' '}
            <span className="req">
              {isOverride ? '(at least one, this is an override)' : '(optional)'}
            </span>
          </legend>
          {ReviewReasonCode.options.map((code) => (
            <label className="choice" key={code}>
              <input type="checkbox" checked={codes.includes(code)} onChange={() => toggle(code)} />
              <span>{REVIEW_REASONS[code]}</span>
            </label>
          ))}
        </fieldset>

        <Field
          label="Internal notes"
          htmlFor="notes"
          hint="Kept with the review. Never shown to the applicant."
        >
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            aria-describedby="notes-hint"
          />
        </Field>

        {isOverride ? (
          <Notice tone="warn" title="This overrides the engine">
            <p>
              The engine recommended <strong>{words(rec.outcome).toLowerCase()}</strong>
              {rec.approvedMonthlyLimitCents !== null
                ? ` at ${money(rec.approvedMonthlyLimitCents)} and ${percent(rec.feeBps)}`
                : ''}
              . You are recording{' '}
              <strong>{decision ? words(OUTCOME_OF[decision]).toLowerCase() : ''}</strong>
              {approving && limitCents !== null && feeBps !== null
                ? ` at ${money(limitCents)} and ${percent(feeBps)}`
                : ''}
              . Overrides are logged as their own audit event and counted.
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>I am overriding the engine&apos;s recommendation on purpose.</span>
            </label>
          </Notice>
        ) : null}

        <Refusal error={review.error} />

        {decision !== null && problems.length > 0 ? (
          <ul className="plain small muted" aria-live="polite">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}

        <Button
          type="submit"
          variant={decision === 'DECLINE' ? 'danger' : 'azure'}
          busy={review.busy}
          disabled={problems.length > 0}
        >
          {decision === null
            ? 'Record the decision'
            : isOverride
              ? `Record override: ${words(decision).toLowerCase()}`
              : `Record: ${words(decision).toLowerCase()}`}
        </Button>
      </form>
    </Card>
  );
}
