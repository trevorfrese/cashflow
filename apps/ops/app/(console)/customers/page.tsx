'use client';

import {
  BusinessStatus,
  OperatorBusinessList,
  type OperatorBusinessListItem,
} from '@cashflow/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  Empty,
  Field,
  LoadError,
  PageHead,
  Pill,
  Skeleton,
  StatusPill,
  Table,
} from '@/components/ui';
import { ApiError, call, query } from '@/lib/api';
import { date, words } from '@/lib/format';

const PAGE = 25;

export default function CustomersPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<OperatorBusinessListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Search as the operator types, a moment after they stop.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  async function load(after: string | null, signal?: AbortSignal) {
    setLoading(true);
    setError(undefined);
    try {
      const page = await call(`businesses${query({ q, status, limit: PAGE, cursor: after })}`, {
        schema: OperatorBusinessList,
        signal,
      });
      setRows((current) => (after && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
      else return;
    }
    setLoading(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [q, status, tick]);

  return (
    <>
      <PageHead
        title="Customers"
        lead="Every business, by name. Open one for its plans, payments, and audit trail."
      />
      <Card>
        <div className="filters">
          <Field
            label="Search"
            htmlFor="customer-search"
            hint="Legal name, trading name, owner email, or a business id."
          >
            <input
              id="customer-search"
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={100}
              aria-describedby="customer-search-hint"
            />
          </Field>
          <Field label="Status" htmlFor="customer-status">
            <select id="customer-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {BusinessStatus.options.map((s) => (
                <option key={s} value={s}>
                  {words(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error ? <LoadError error={error} retry={() => setTick((t) => t + 1)} /> : null}
        {rows === null ? (
          error ? null : (
            <Skeleton rows={8} />
          )
        ) : rows.length === 0 ? (
          <Empty title="No business matches">
            {q ? `Nothing found for "${q}".` : 'There are no businesses yet.'}
          </Empty>
        ) : (
          <div aria-busy={loading || undefined} className={loading ? 'reloading' : undefined}>
            <Table
              caption="Businesses"
              head={[
                'Business',
                'Owner',
                'Status',
                'Verification',
                'Latest application',
                { num: 'Open plans' },
                'Standing',
                'Joined',
              ]}
            >
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link className="cell-main" href={`/customers/${b.id}`}>
                      {b.legalName}
                    </Link>
                    <div className="muted small">
                      {words(b.industry)}, {b.city}, {b.state}
                    </div>
                  </td>
                  <td>{b.ownerEmail}</td>
                  <td>
                    <StatusPill code={b.status} />
                  </td>
                  <td>
                    <StatusPill code={b.verificationStatus} />
                    {b.openScreeningHits > 0 ? (
                      <>
                        {' '}
                        <Pill tone="bad">Screening hit</Pill>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {b.latestApplicationStatus ? (
                      <StatusPill code={b.latestApplicationStatus} />
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="num">{b.openPlans}</td>
                  <td>
                    {b.worstDelinquency ? (
                      <StatusPill code={b.worstDelinquency} />
                    ) : (
                      <span className="muted">No plan</span>
                    )}
                    {b.frozenPlans > 0 ? (
                      <>
                        {' '}
                        <Pill tone="warn">Frozen</Pill>
                      </>
                    ) : null}
                  </td>
                  <td className="nowrap">{date(b.createdAt)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
        {rows && rows.length > 0 ? (
          <div className="row">
            <span className="muted small" aria-live="polite">
              Showing {rows.length}
              {cursor ? ', more to load' : ''}
            </span>
            {cursor ? (
              <Button small busy={loading} onClick={() => void load(cursor)}>
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}
