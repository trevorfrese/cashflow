'use client';

import { BusinessLimitView, RentPlan } from '@cashflow/shared';
import { useId, useState } from 'react';

import { ReasonAction } from '@/components/shared';
import { Button, Card, Facts, Field, Notice, Refusal } from '@/components/ui';
import { dateTime, money, parseDollars } from '@/lib/format';
import { useIsAdmin } from '@/lib/session-context';
import { useAction } from '@/lib/use-api';

/**
 * The tighten-only controls on a customer: lower the limit (and take an admin's cap off
 * again), and freeze a plan's next period. Admin only. The API enforces the role and the
 * direction; hiding the buttons from a reviewer is only a convenience.
 */

export function LimitCard({
  limit,
  onChanged,
}: {
  limit: BusinessLimitView;
  onChanged: () => void;
}) {
  const isAdmin = useIsAdmin();
  const capped = limit.capCents !== null;
  return (
    <Card title="Limit" aside={capped ? 'Lowered by an admin' : 'As underwriting set it'}>
      <Facts
        rows={[
          ['Approved by underwriting', money(limit.decisionLimitCents)],
          ['Admin cap', capped ? money(limit.capCents) : 'None'],
          ['Limit in force', money(limit.effectiveLimitCents)],
          capped
            ? ['Capped by', `${limit.capSetBy ?? 'unknown'}, ${dateTime(limit.capSetAt)}`]
            : null,
          capped ? ['Why', limit.capReason ?? '-'] : null,
        ]}
      />
      <p className="muted small">
        The limit in force applies to a new plan and to a rent increase. A cap only ever lowers the
        limit; raising one goes through underwriting.
      </p>
      {limit.plansAboveLimit.length > 0 ? (
        <Notice
          tone="warn"
          title={
            limit.plansAboveLimit.length === 1
              ? 'A running plan is above the limit in force'
              : `${limit.plansAboveLimit.length} running plans are above the limit in force`
          }
        >
          <p>
            {limit.plansAboveLimit.map((p) => money(p.monthlyRentCents)).join(', ')} a month. A cap
            does not stop a running plan. To stop the next period, freeze the plan below.
          </p>
        </Notice>
      ) : null}
      {!isAdmin ? (
        <p className="muted small">Lowering a limit needs the admin role.</p>
      ) : limit.effectiveLimitCents === null ? null : (
        <div className="row">
          <LowerLimit limit={limit} onChanged={onChanged} />
          {capped ? (
            <ReasonAction
              path={`businesses/${limit.businessId}/limit/remove-cap`}
              schema={BusinessLimitView}
              body={(reason) => ({ reason })}
              trigger="Remove the cap"
              submit="Remove the cap"
              label="Why the underwriting limit should apply again"
              hint="Recorded in the audit log under your name."
              variant="plain"
              onDone={onChanged}
            >
              <p className="small">
                The limit goes back to {money(limit.decisionLimitCents)}, what underwriting
                approved.
              </p>
            </ReasonAction>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function LowerLimit({ limit, onChanged }: { limit: BusinessLimitView; onChanged: () => void }) {
  const amountId = useId();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction<{ limitCents: number; reason: string }, BusinessLimitView>(
    `businesses/${limit.businessId}/limit/lower`,
    BusinessLimitView,
    () => {
      setOpen(false);
      setAmount('');
      setReason('');
      onChanged();
    },
  );
  const cents = parseDollars(amount);
  const current = limit.effectiveLimitCents ?? 0;
  const amountError =
    amount.trim() === ''
      ? null
      : cents === null
        ? 'Type an amount in dollars, like 2500.'
        : cents >= current
          ? `It has to be below the limit in force, ${money(current)}.`
          : null;
  const valid = cents !== null && cents < current && reason.trim().length >= 3;

  if (!open) {
    return (
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Lower the limit
        </Button>
      </div>
    );
  }
  return (
    <form
      className="form well"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && cents !== null) void action.run({ limitCents: cents, reason: reason.trim() });
      }}
    >
      <Field
        label="New monthly limit, in dollars"
        htmlFor={amountId}
        required
        error={amountError}
        hint={`Below ${money(current)}. Zero stops any new rent from being fronted.`}
      >
        <input
          id={amountId}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
          required
        />
      </Field>
      <Field
        label="Why"
        htmlFor={reasonId}
        required
        hint="Recorded with the cap and in the audit log under your name."
      >
        <textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          required
        />
      </Field>
      <Refusal error={action.error} />
      <div className="row">
        <Button type="submit" variant="danger" busy={action.busy} disabled={!valid}>
          Lower the limit
        </Button>
        <Button
          onClick={() => {
            setOpen(false);
            action.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Freeze a plan's next period. Shown on an open plan that is not frozen, to an admin. */
export function FreezePlan({ planId, onChanged }: { planId: string; onChanged: () => void }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;
  return (
    <ReasonAction
      path={`rent-plans/${planId}/freeze`}
      schema={RentPlan}
      body={(reason) => ({ reason })}
      trigger="Freeze the next period"
      submit="Freeze"
      label="Why this plan should stop fronting rent"
      hint="Recorded in the audit log under your name. Only an admin can release this freeze."
      variant="danger"
      onDone={onChanged}
    >
      <p className="small">
        No new rent period is generated and a payout that falls due is held, then cancelled once its
        release window passes. Rent already fronted is still collected.
      </p>
    </ReasonAction>
  );
}
