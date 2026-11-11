'use client';

import { LeaseChangeView, type LandlordDetailsView } from '@cashflow/shared';
import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';

import { ReasonAction } from '@/components/shared';
import {
  Button,
  Card,
  Empty,
  Facts,
  Load,
  Notice,
  PageHead,
  StatusPill,
  Table,
} from '@/components/ui';
import { date, dateTime, fieldLabel, month, money } from '@/lib/format';
import { useApi } from '@/lib/use-api';

const Changes = z.array(LeaseChangeView);

const FIELDS: Array<[keyof LandlordDetailsView, string]> = [
  ['landlordName', 'Landlord name'],
  ['landlordEmail', 'Landlord email'],
  ['accountHolderName', 'Account holder'],
  ['routingNumber', 'Routing number'],
  ['accountNumberLast4', 'Account, last 4'],
];

export default function LeaseChangesPage() {
  const [all, setAll] = useState(false);
  const changes = useApi(`lease-changes?status=${all ? 'ALL' : 'PENDING'}`, Changes);
  return (
    <>
      <PageHead
        title="Lease changes"
        lead="Changes to who gets paid. Each one waits out a cooling-off period unless a reviewer approves or rejects it first. Payouts on the lease are held meanwhile."
        actions={
          <>
            <Button small onClick={() => setAll((v) => !v)} aria-pressed={all}>
              {all ? 'Show pending only' : 'Show decided too'}
            </Button>
            <Button small onClick={changes.reload}>
              Refresh
            </Button>
          </>
        }
      />
      <Load from={changes} rows={6}>
        {(items) =>
          items.length === 0 ? (
            <Empty title={all ? 'No lease changes on record' : 'No lease changes are waiting'}>
              A change appears here when an owner edits the landlord or the payout account on a
              lease with a running plan.
            </Empty>
          ) : (
            <div className="stack">
              {items.map((change) => (
                <ChangeCard key={change.id} change={change} onDecided={changes.reload} />
              ))}
            </div>
          )
        }
      </Load>
    </>
  );
}

function ChangeCard({ change, onDecided }: { change: LeaseChangeView; onDecided: () => void }) {
  const { previous, proposed } = change;
  const pending = change.status === 'PENDING';
  const blocked = change.screening !== null && !change.screening.cleared;
  return (
    <Card
      title={
        <>
          <Link href={`/customers/${change.businessId}`}>{change.businessName}</Link>
        </>
      }
      aside={<StatusPill code={change.status} />}
    >
      <Facts
        rows={[
          ['Requested', dateTime(change.requestedAt)],
          [pending ? 'Takes effect on its own' : 'Was to take effect', date(change.effectiveOn)],
          ['What changes', change.fields.map(fieldLabel).join(', ') || 'Nothing listed'],
          [
            'Screening of the new landlord',
            change.screening ? (
              <>
                <StatusPill code={change.screening.result} />{' '}
                {change.screening.result !== 'CLEAR'
                  ? change.screening.cleared
                    ? 'Cleared by a reviewer'
                    : 'Not cleared'
                  : null}
              </>
            ) : (
              'Not screened'
            ),
          ],
          change.decidedAt
            ? ['Decided', `${dateTime(change.decidedAt)} by ${change.decidedBy ?? 'unknown'}`]
            : null,
          change.decisionReason ? ['Reason', change.decisionReason] : null,
          change.appliedAt ? ['Applied', dateTime(change.appliedAt)] : null,
          change.cancelledAt ? ['Cancelled by the owner', dateTime(change.cancelledAt)] : null,
        ]}
      />

      <Table caption="Previous and proposed landlord details" head={['', 'Previous', 'Proposed']}>
        {FIELDS.map(([key, label]) => {
          const before = previous[key];
          const after = proposed[key];
          // The proposal lists only what changes. A field it leaves out stays as it was.
          const changed = after !== undefined && after !== before;
          if (before === undefined && after === undefined) return null;
          return (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td>{before ?? <span className="muted">Not recorded</span>}</td>
              <td className={changed ? 'changed' : undefined}>
                {changed ? String(after) : <span className="muted">Unchanged</span>}
              </td>
            </tr>
          );
        })}
        <tr>
          <th scope="row">Payout destination</th>
          <td className="muted">Token not shown</td>
          <td className={proposed.payoutTokenChanged ? 'changed' : undefined}>
            {proposed.payoutTokenChanged ? (
              'Changes. The token is never shown.'
            ) : (
              <span className="muted">Unchanged</span>
            )}
          </td>
        </tr>
      </Table>

      {pending ? (
        <div>
          <h3 className="sub">Payouts this affects</h3>
          {change.affectedPayouts.length === 0 ? (
            <p className="muted">No payout is held or falls due before the change takes effect.</p>
          ) : (
            <Table
              caption="Affected payouts"
              head={['Period', 'Scheduled', { num: 'Amount' }, 'Status']}
            >
              {change.affectedPayouts.map((p) => (
                <tr key={p.id}>
                  <td>{month(p.periodMonth)}</td>
                  <td className="nowrap">{date(p.scheduledFor)}</td>
                  <td className="num">{money(p.amountCents)}</td>
                  <td>
                    <StatusPill code={p.status} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      ) : null}

      {pending ? (
        <>
          {blocked ? (
            <Notice tone="bad" title="The proposed landlord has an open screening hit">
              <p>
                Look at it in the <Link href="/screening">screening queue</Link> before approving
                this change.
              </p>
            </Notice>
          ) : null}
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <ReasonAction
              path={`lease-changes/${change.id}/decide`}
              schema={LeaseChangeView}
              body={(reason) => ({ decision: 'APPROVE', reason })}
              trigger="Approve now"
              submit="Approve the change"
              label="How you confirmed the change is genuine"
              hint="For example a call back to the landlord on a number already on file."
              onDone={onDecided}
            >
              <p>
                Approving applies the new details now, without waiting for{' '}
                {date(change.effectiveOn)}. Held payouts go to the new account on the next job run.
              </p>
            </ReasonAction>
            <ReasonAction
              path={`lease-changes/${change.id}/decide`}
              schema={LeaseChangeView}
              body={(reason) => ({ decision: 'REJECT', reason })}
              trigger="Reject"
              submit="Reject the change"
              variant="danger"
              label="Why the change is rejected"
              onDone={onDecided}
            >
              <p>Rejecting keeps the previous details. Payouts go to the account on file.</p>
            </ReasonAction>
          </div>
        </>
      ) : null}
    </Card>
  );
}
