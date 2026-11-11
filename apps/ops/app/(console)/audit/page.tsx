'use client';

import { AuditLogPage, type AuditEventView } from '@cashflow/shared';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { AuditTable } from '@/components/shared';
import { Button, Card, Empty, Field, LoadError, Notice, PageHead, Skeleton } from '@/components/ui';
import { ApiError, call, query } from '@/lib/api';
import { words } from '@/lib/format';

const PAGE = 50;
const ACTOR_TYPES = ['system', 'job', 'user', 'reviewer', 'admin'];

interface Filters {
  subjectType: string;
  eventType: string;
  actorType: string;
  actor: string;
  from: string;
  to: string;
}

const EMPTY: Filters = {
  subjectType: '',
  eventType: '',
  actorType: '',
  actor: '',
  from: '',
  to: '',
};

export default function AuditPage() {
  const search = useSearchParams();
  const businessId = search.get('businessId') ?? '';

  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [options, setOptions] = useState<{ eventTypes: string[]; subjectTypes: string[] }>({
    eventTypes: [],
    subjectTypes: [],
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  async function load(after: string | null) {
    setLoading(true);
    setError(undefined);
    try {
      const page = await call(
        `audit-log${query({ ...filters, businessId, limit: PAGE, cursor: after })}`,
        { schema: AuditLogPage },
      );
      setEvents((current) => (after && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setOptions({ eventTypes: page.eventTypes, subjectTypes: page.subjectTypes });
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(null);
  }, [filters, businessId, tick]);

  const set = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  function apply(e: FormEvent) {
    e.preventDefault();
    setFilters({ ...draft, actor: draft.actor.trim() });
  }

  return (
    <>
      <PageHead
        title="Audit log"
        lead="Who did what to which record, and when. Newest first. The log is append-only: nothing in it is edited or removed."
      />
      {businessId ? (
        <Notice tone="info" title="Showing one business">
          <p>
            Events about business <span className="mono">{businessId}</span> and its applications,
            plans, leases, and screenings. <a href="/audit">Show every event</a>
          </p>
        </Notice>
      ) : null}
      <Card>
        <form className="form" onSubmit={apply}>
          <div className="filters">
            <Field label="Subject type" htmlFor="a-subject">
              <select id="a-subject" value={draft.subjectType} onChange={set('subjectType')}>
                <option value="">Any subject</option>
                {options.subjectTypes.map((s) => (
                  <option key={s} value={s}>
                    {words(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Event" htmlFor="a-event">
              <select id="a-event" value={draft.eventType} onChange={set('eventType')}>
                <option value="">Any event</option>
                {options.eventTypes.map((s) => (
                  <option key={s} value={s}>
                    {words(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Actor kind" htmlFor="a-actor-type">
              <select id="a-actor-type" value={draft.actorType} onChange={set('actorType')}>
                <option value="">Anyone</option>
                {ACTOR_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {words(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Actor name contains" htmlFor="a-actor">
              <input
                id="a-actor"
                type="text"
                value={draft.actor}
                onChange={set('actor')}
                maxLength={120}
              />
            </Field>
            <Field label="From (UTC)" htmlFor="a-from">
              <input id="a-from" type="date" value={draft.from} onChange={set('from')} />
            </Field>
            <Field label="To (UTC)" htmlFor="a-to">
              <input id="a-to" type="date" value={draft.to} onChange={set('to')} />
            </Field>
          </div>
          <div className="row">
            <Button type="submit" variant="azure" small>
              Apply filters
            </Button>
            <Button
              small
              onClick={() => {
                setDraft(EMPTY);
                setFilters(EMPTY);
              }}
            >
              Clear
            </Button>
            <Button small onClick={() => setTick((t) => t + 1)}>
              Refresh
            </Button>
          </div>
        </form>

        {error ? <LoadError error={error} retry={() => setTick((t) => t + 1)} /> : null}
        {events === null ? (
          error ? null : (
            <Skeleton rows={10} />
          )
        ) : events.length === 0 ? (
          <Empty title="No events match these filters" />
        ) : (
          <div aria-busy={loading || undefined} className={loading ? 'reloading' : undefined}>
            <AuditTable events={events} caption="Audit events, newest first" />
          </div>
        )}
        {events && events.length > 0 ? (
          <div className="row">
            <span className="muted small" aria-live="polite">
              Showing {events.length}
              {cursor ? ', older events to load' : ', that is all of them'}
            </span>
            {cursor ? (
              <Button small busy={loading} onClick={() => void load(cursor)}>
                Load older
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}
