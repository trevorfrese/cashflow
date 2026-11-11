'use client';

import { ScreeningResult } from '@cashflow/shared';
import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';

import { ReasonAction } from '@/components/shared';
import {
  Card,
  Empty,
  Facts,
  Field,
  Load,
  Notice,
  PageHead,
  Button,
  StatusPill,
} from '@/components/ui';
import { dateTime, words } from '@/lib/format';
import { useIsAdmin } from '@/lib/session-context';
import { useApi } from '@/lib/use-api';

const Hits = z.array(ScreeningResult);

const VIEWS = [
  ['open', 'Open hits'],
  ['cleared', 'Cleared hits'],
  ['all', 'All hits'],
] as const;

const PARTY: Record<string, string> = {
  BUSINESS: 'The business',
  OWNER: 'A beneficial owner',
  LANDLORD: 'A landlord',
};

export default function ScreeningPage() {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('open');
  const hits = useApi(`screening/hits?status=${view}`, Hits);
  return (
    <>
      <PageHead
        title="Screening"
        lead="Sanctions and watchlist hits on businesses, owners, and landlords. An open hit freezes the plans it touches and blocks approval until someone clears it."
        actions={
          <Button small onClick={hits.reload}>
            Refresh
          </Button>
        }
      />
      <Card tone="canvas">
        <div className="filters">
          <Field label="Show" htmlFor="screening-view">
            <select
              id="screening-view"
              value={view}
              onChange={(e) => setView(e.target.value as typeof view)}
            >
              {VIEWS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
      <Load from={hits} rows={5}>
        {(items) =>
          items.length === 0 ? (
            <Empty title={view === 'open' ? 'No open screening hits' : 'No hits to show'}>
              Every party is screened when it is added and again every 30 days.
            </Empty>
          ) : (
            <div className="stack">
              {items.map((hit) => (
                <HitCard key={hit.id} hit={hit} onCleared={hits.reload} />
              ))}
            </div>
          )
        }
      </Load>
    </>
  );
}

function HitCard({ hit, onCleared }: { hit: ScreeningResult; onCleared: () => void }) {
  const isAdmin = useIsAdmin();
  const needsAdmin = hit.result === 'MATCH' && !isAdmin;
  return (
    <Card
      title={hit.nameScreened}
      aside={
        <>
          <StatusPill code={hit.result} />
          {hit.open ? <StatusPill code="OPEN" /> : null}
        </>
      }
    >
      <Facts
        rows={[
          ['Who was screened', PARTY[hit.partyType] ?? words(hit.partyType)],
          [
            'Customer',
            <Link key="b" href={`/customers/${hit.businessId}`}>
              {hit.businessName}
            </Link>,
          ],
          ['Name screened', hit.nameScreened],
          ['Country', hit.country ?? 'Not given'],
          ['Screened', dateTime(hit.screenedAt)],
          ['Provider', hit.provider],
          [
            'Provider reference',
            <span key="r" className="mono">
              {hit.providerRef ?? '-'}
            </span>,
          ],
          [
            'Plans frozen by this hit',
            hit.frozenRentPlanIds.length === 0 ? 'None' : hit.frozenRentPlanIds.length,
          ],
          hit.leaseChangeId
            ? [
                'Part of',
                <Link key="l" href="/lease-changes">
                  A pending lease change
                </Link>,
              ]
            : null,
          hit.clearedAt
            ? ['Cleared', `${dateTime(hit.clearedAt)} by ${hit.clearedBy ?? 'unknown'}`]
            : null,
          hit.clearedReason ? ['Why it was cleared', hit.clearedReason] : null,
          hit.supersededAt ? ['Replaced by a later screening', dateTime(hit.supersededAt)] : null,
        ]}
      />
      {hit.open ? (
        <>
          {hit.result === 'MATCH' ? (
            <Notice tone="bad" title="This is a match, not a possible match">
              <p>
                Only an admin can clear a match, and only when the match is shown not to be this
                party. A true match is not cleared: escalate it.
              </p>
            </Notice>
          ) : null}
          <ReasonAction
            path={`screening/${hit.id}/clear`}
            schema={ScreeningResult}
            body={(reason) => ({ reason })}
            trigger="Clear this hit"
            submit="Clear the hit"
            label="Why this is not the party"
            hint="What you checked: date of birth, address, the list entry. Stored and audited."
            onDone={onCleared}
            disabledReason={
              needsAdmin
                ? 'Clearing a match needs the admin role. You are signed in as a reviewer.'
                : undefined
            }
          >
            <p>
              Clearing records that the listed party is someone else, and releases the plans this
              hit froze.
            </p>
          </ReasonAction>
        </>
      ) : null}
    </Card>
  );
}
