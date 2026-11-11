'use client';

import type { Alert, AuditEventView } from '@cashflow/shared';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import type { ZodType } from 'zod';

import { Button, Empty, Field, Refusal, SeverityPill, StatusPill, Table } from '@/components/ui';
import { age, dateTime, detailRows, words } from '@/lib/format';
import { useAction } from '@/lib/use-api';

/** Where a subject lives in the console, when it has a page. */
export function subjectHref(subjectType: string, subjectId: string): string | null {
  switch (subjectType) {
    case 'business':
      return `/customers/${subjectId}`;
    case 'application':
      return `/reviews/${subjectId}`;
    case 'alert':
      return `/alerts/${subjectId}`;
    default:
      return null;
  }
}

export function SubjectLink({ type, id }: { type: string; id: string }) {
  const href = subjectHref(type, id);
  return (
    <span>
      {words(type)}{' '}
      {href ? (
        <Link className="mono" href={href}>
          {id}
        </Link>
      ) : (
        <span className="mono">{id}</span>
      )}
    </span>
  );
}

/** Audit events as a table: when, who, what, on what, and the payload on request. */
export function AuditTable({
  events,
  showSubject = true,
  caption = 'Audit trail',
}: {
  events: readonly AuditEventView[];
  showSubject?: boolean;
  caption?: string;
}) {
  if (events.length === 0) return <Empty title="No audit events" />;
  return (
    <Table
      caption={caption}
      head={['When', 'Who', 'Event', ...(showSubject ? ['Subject'] : []), 'Detail']}
    >
      {events.map((e) => {
        const rows = detailRows(e.payload);
        return (
          <tr key={e.id}>
            <td className="nowrap">{dateTime(e.at)}</td>
            <td>
              <div className="cell-main">{e.actorId ?? words(e.actorType)}</div>
              <div className="muted small">{words(e.actorType)}</div>
            </td>
            <td>{words(e.eventType)}</td>
            {showSubject ? (
              <td>
                <SubjectLink type={e.subjectType} id={e.subjectId} />
              </td>
            ) : null}
            <td>
              {rows.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                <details className="payload">
                  <summary>
                    {rows.length} {rows.length === 1 ? 'field' : 'fields'}
                  </summary>
                  <pre>{rows.map((r) => `${r.label}: ${r.value}`).join('\n')}</pre>
                </details>
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export function AlertsTable({ alerts, caption }: { alerts: readonly Alert[]; caption: string }) {
  return (
    <Table
      caption={caption}
      head={['Severity', 'Alert', 'Category', 'Status', 'Opened', 'Last seen']}
    >
      {alerts.map((a) => (
        <tr key={a.id}>
          <td>
            <SeverityPill severity={a.severity} />
          </td>
          <td>
            <Link className="cell-main" href={`/alerts/${a.id}`}>
              {a.title}
            </Link>
            <div className="muted small mono">{a.type}</div>
          </td>
          <td>{words(a.category)}</td>
          <td>
            <StatusPill code={a.status} />
          </td>
          <td className="nowrap">
            {age(a.createdAt)}
            <div className="muted small">{dateTime(a.createdAt)}</div>
          </td>
          <td className="nowrap">{dateTime(a.lastSeenAt)}</td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * An action that needs a written reason and nothing else: approve or reject a lease change,
 * clear a screening hit, release a freeze, send a payout again. Closed, it is one button.
 * Open, it is the reason field, the API's refusal if there was one, and a submit.
 */
export function ReasonAction<T>({
  path,
  schema,
  body,
  trigger,
  submit,
  label,
  hint,
  variant = 'azure',
  onDone,
  disabledReason,
  children,
}: {
  path: string;
  schema: ZodType<T>;
  /** The request body for a reason. */
  body: (reason: string) => unknown;
  /** The closed button. */
  trigger: string;
  /** The button that sends it. */
  submit: string;
  label: string;
  hint?: ReactNode;
  variant?: 'azure' | 'danger' | 'gold' | 'plain';
  onDone: (result: T) => void;
  /** When set, the action is not offered and this says why. */
  disabledReason?: string;
  /** Shown above the reason field: what the action will do. */
  children?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction<unknown, T>(path, schema, (result) => {
    setOpen(false);
    setReason('');
    onDone(result);
  });
  const valid = reason.trim().length >= 3;

  if (disabledReason) {
    return (
      <div className="stack-tight">
        <div>
          <Button variant={variant} disabled>
            {trigger}
          </Button>
        </div>
        <p className="muted small">{disabledReason}</p>
      </div>
    );
  }
  if (!open) {
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }
  return (
    <form
      className="form well"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void action.run(body(reason.trim()));
      }}
    >
      {children}
      <Field label={label} htmlFor={id} required hint={hint}>
        <textarea
          id={id}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          required
          autoFocus
        />
      </Field>
      <Refusal error={action.error} />
      <div className="row">
        <Button type="submit" variant={variant} busy={action.busy} disabled={!valid}>
          {submit}
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
