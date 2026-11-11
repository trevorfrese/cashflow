'use client';

import {
  Alert,
  AlertDetail,
  ResolveAlertRequest,
  type AcknowledgeAlertRequest,
} from '@cashflow/shared';
import Link from 'next/link';
import { use, useState } from 'react';

import { AlertsTable, AuditTable } from '@/components/shared';
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
  SeverityPill,
  StatusPill,
  Table,
} from '@/components/ui';
import { age, dateTime, detailRows, measures, words } from '@/lib/format';
import { dispositionLabel } from '@/lib/labels';
import { useAction, useApi } from '@/lib/use-api';

const DISPOSITIONS = ResolveAlertRequest.shape.disposition.options;

export default function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi(`alerts/${id}`, AlertDetail);
  return (
    <Load from={detail} rows={8}>
      {(d) => <AlertView detail={d} reload={detail.reload} />}
    </Load>
  );
}

function AlertView({ detail, reload }: { detail: AlertDetail; reload: () => void }) {
  const { alert, subject, rule } = detail;
  const compared = measures(alert.detail);
  const rows = detailRows(alert.detail);
  return (
    <>
      <PageHead
        back={{ href: '/alerts', label: 'Alerts' }}
        title={alert.title}
        actions={
          <>
            <SeverityPill severity={alert.severity} />
            <StatusPill code={alert.status} />
          </>
        }
      />
      <div className="split">
        <div className="stack">
          <Card title="What the rule checks" aside={<span className="mono">{alert.type}</span>}>
            {rule ? (
              <>
                <p>{rule.description}</p>
                <div className="row">
                  <Pill tone={rule.autoResolves ? 'info' : 'neutral'}>
                    {rule.autoResolves ? 'Resolves on its own' : 'Needs a person to resolve'}
                  </Pill>
                  {rule.tripsCircuitBreaker ? (
                    <Pill tone="bad">Can trip the circuit breaker</Pill>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="muted">This rule is no longer in the rule set.</p>
            )}
          </Card>

          <Card title="What it measured">
            {compared.length > 0 ? (
              <Table
                caption="Measured value against its threshold"
                head={['Measure', { num: 'Measured' }, { num: 'Against' }]}
              >
                {compared.map((m) => (
                  <tr key={`${m.label}-${m.thresholdLabel}`}>
                    <td className="cell-main">{m.label}</td>
                    <td className="num">{m.value}</td>
                    <td className="num">
                      {m.threshold} <span className="muted">({m.thresholdLabel})</span>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : null}
            {rows.length > 0 ? (
              <Facts wide rows={rows.map((r) => [r.label, r.value] as [string, string])} />
            ) : (
              <p className="muted">The rule stored no numbers with this alert.</p>
            )}
          </Card>

          <Card title="What it is about">
            <p className="cell-main">{subject.label}</p>
            <ul className="plain">
              {subject.businessId ? (
                <li>
                  <Link href={`/customers/${subject.businessId}`}>
                    Customer: {subject.businessName ?? subject.businessId}
                  </Link>
                </li>
              ) : null}
              {subject.applicationId ? (
                <li>
                  <Link href={`/reviews/${subject.applicationId}`}>Application</Link>
                </li>
              ) : null}
              {subject.leaseId ? (
                <li>
                  <Link href="/lease-changes">Lease changes queue</Link>
                  <span className="muted small mono">lease {subject.leaseId}</span>
                </li>
              ) : null}
              {subject.rentPlanId ? (
                <li className="muted small mono">rent plan {subject.rentPlanId}</li>
              ) : null}
              {!subject.businessId && !subject.applicationId && !subject.leaseId ? (
                <li className="muted">
                  {words(subject.subjectType)} <span className="mono">{subject.subjectId}</span>
                </li>
              ) : null}
            </ul>
            <Facts
              rows={[
                ['Opened', `${dateTime(alert.createdAt)} (${age(alert.createdAt)})`],
                ['Last seen by the monitor', dateTime(alert.lastSeenAt)],
                [
                  'Acknowledged',
                  alert.acknowledgedAt
                    ? `${dateTime(alert.acknowledgedAt)} by ${alert.acknowledgedBy ?? 'unknown'}`
                    : 'Not yet',
                ],
                [
                  'Resolved',
                  alert.resolvedAt
                    ? `${dateTime(alert.resolvedAt)} by ${alert.resolvedBy ?? 'the monitor'}`
                    : 'Not yet',
                ],
                alert.disposition ? ['Disposition', dispositionLabel(alert.disposition)] : null,
              ]}
            />
            {alert.notes ? (
              <div>
                <h3 className="sub">Notes</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{alert.notes}</p>
              </div>
            ) : null}
          </Card>

          <Card title="Related alerts" aside={`${detail.relatedAlerts.length} on the same subject`}>
            {detail.relatedAlerts.length === 0 ? (
              <Empty title="No other alerts on this subject" />
            ) : (
              <AlertsTable alerts={detail.relatedAlerts} caption="Related alerts" />
            )}
          </Card>

          <Card title="Audit trail">
            <AuditTable events={detail.auditEvents} />
          </Card>
        </div>

        <div className="split-side">
          <AlertActions
            alert={alert}
            autoResolves={rule?.autoResolves ?? false}
            onChanged={reload}
          />
        </div>
      </div>
    </>
  );
}

function AlertActions({
  alert,
  autoResolves,
  onChanged,
}: {
  alert: Alert;
  autoResolves: boolean;
  onChanged: () => void;
}) {
  const [ackNotes, setAckNotes] = useState('');
  const [disposition, setDisposition] = useState<(typeof DISPOSITIONS)[number] | ''>('');
  const [notes, setNotes] = useState('');
  const acknowledge = useAction<AcknowledgeAlertRequest, Alert>(
    `alerts/${alert.id}/acknowledge`,
    Alert,
    () => {
      setAckNotes('');
      onChanged();
    },
  );
  const resolve = useAction<ResolveAlertRequest, Alert>(`alerts/${alert.id}/resolve`, Alert, () => {
    setNotes('');
    onChanged();
  });

  if (alert.status === 'RESOLVED') {
    return (
      <Card title="Resolved">
        <p>
          {dispositionLabel(alert.disposition)}. Closed {dateTime(alert.resolvedAt)} by{' '}
          {alert.resolvedBy ?? 'the monitor'}.
        </p>
      </Card>
    );
  }

  const canResolve = disposition !== '' && notes.trim().length >= 3;
  return (
    <div className="stack">
      {alert.status === 'OPEN' ? (
        <Card title="Acknowledge">
          <p className="muted">Says you have seen it and are looking. It stays open.</p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void acknowledge.run(ackNotes.trim() ? { notes: ackNotes.trim() } : {});
            }}
          >
            <Field label="Notes" htmlFor="ack-notes" hint="Optional.">
              <textarea
                id="ack-notes"
                value={ackNotes}
                onChange={(e) => setAckNotes(e.target.value)}
                maxLength={2000}
              />
            </Field>
            <Refusal error={acknowledge.error} />
            <Button type="submit" busy={acknowledge.busy}>
              Acknowledge
            </Button>
          </form>
        </Card>
      ) : (
        <Card title="Acknowledged">
          <p>
            {dateTime(alert.acknowledgedAt)} by {alert.acknowledgedBy ?? 'unknown'}.
          </p>
        </Card>
      )}

      <Card title="Resolve">
        {autoResolves ? (
          <Notice tone="warn" title="Resolving this suppresses it for 30 days">
            <p>
              This rule closes its own alerts when the condition clears. If you resolve it while the
              condition is still there, the same condition will not open a new alert for 30 days.
              Resolve it only once you have looked into it.
            </p>
          </Notice>
        ) : (
          <p className="muted">
            This rule does not close its own alerts. It stays open until a person resolves it.
          </p>
        )}
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (disposition !== '' && canResolve) {
              void resolve.run({ disposition, notes: notes.trim() });
            }
          }}
        >
          <Field label="Disposition" htmlFor="disposition" required>
            <select
              id="disposition"
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as typeof disposition)}
              required
            >
              <option value="">Choose one</option>
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {dispositionLabel(d)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Notes"
            htmlFor="resolve-notes"
            required
            hint="What you found and what was done. Kept on the alert and in the audit log."
          >
            <textarea
              id="resolve-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              required
              aria-describedby="resolve-notes-hint"
            />
          </Field>
          <Refusal error={resolve.error} />
          <Button type="submit" variant="azure" busy={resolve.busy} disabled={!canResolve}>
            Resolve
          </Button>
        </form>
      </Card>
    </div>
  );
}
