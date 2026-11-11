'use client';

import { AlertCategory, AlertList, AlertSeverity, type Alert } from '@cashflow/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AlertsTable } from '@/components/shared';
import { Button, Card, Empty, Field, LoadError, PageHead, Skeleton } from '@/components/ui';
import { ApiError, call, query } from '@/lib/api';
import { bySeverityThenAge, words } from '@/lib/format';
import { SEVERITY } from '@/lib/labels';

const STATUSES = [
  ['ACTIVE', 'Open and acknowledged'],
  ['OPEN', 'Open, not acknowledged'],
  ['ACKNOWLEDGED', 'Acknowledged'],
  ['RESOLVED', 'Resolved'],
  ['ALL', 'All'],
] as const;

const PAGE = 100;

export default function AlertsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const status = search.get('status') ?? 'ACTIVE';
  const severity = search.get('severity') ?? '';
  const category = search.get('category') ?? '';

  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // The filters live in the address, so a filtered queue can be linked to and reloaded.
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size > 0 ? `?${next.toString()}` : ''}`);
  };

  async function load(after: string | null) {
    setLoading(true);
    setError(undefined);
    try {
      const page = await call(
        `alerts${query({ status, severity, category, limit: PAGE, cursor: after })}`,
        { schema: AlertList },
      );
      setAlerts((current) => (after && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(null);
    // Reload from the top whenever a filter changes or a refresh is asked for.
  }, [status, severity, category, tick]);

  const sorted = alerts ? bySeverityThenAge(alerts) : null;

  return (
    <>
      <PageHead
        title="Alerts"
        lead="Raised by the monitoring rules. Most severe first, then oldest first."
        actions={
          <Button small onClick={() => setTick((t) => t + 1)}>
            Refresh
          </Button>
        }
      />
      <Card>
        <div className="filters">
          <Field label="Status" htmlFor="f-status">
            <select
              id="f-status"
              value={status}
              onChange={(e) =>
                setFilter('status', e.target.value === 'ACTIVE' ? '' : e.target.value)
              }
            >
              {STATUSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Severity" htmlFor="f-severity">
            <select
              id="f-severity"
              value={severity}
              onChange={(e) => setFilter('severity', e.target.value)}
            >
              <option value="">Any severity</option>
              {[...AlertSeverity.options].reverse().map((s) => (
                <option key={s} value={s}>
                  {SEVERITY[s].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" htmlFor="f-category">
            <select
              id="f-category"
              value={category}
              onChange={(e) => setFilter('category', e.target.value)}
            >
              <option value="">Any category</option>
              {AlertCategory.options.map((c) => (
                <option key={c} value={c}>
                  {words(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error ? <LoadError error={error} retry={() => setTick((t) => t + 1)} /> : null}
        {sorted === null ? (
          error ? null : (
            <Skeleton rows={6} />
          )
        ) : sorted.length === 0 ? (
          <Empty title="No alerts match these filters">
            {status === 'ACTIVE' && !severity && !category
              ? 'Nothing is open. The monitor raises alerts here when a rule finds something.'
              : 'Try a wider status or clear a filter.'}
          </Empty>
        ) : (
          <div aria-busy={loading || undefined} className={loading ? 'reloading' : undefined}>
            <AlertsTable alerts={sorted} caption="Alerts, most severe first" />
          </div>
        )}
        {sorted && sorted.length > 0 ? (
          <div className="row">
            <span className="muted small" aria-live="polite">
              Showing {sorted.length}
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
