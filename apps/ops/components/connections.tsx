'use client';

import type {
  OperatorConnection,
  OperatorConnections,
  TrustTier,
  VeracityFinding,
} from '@cashflow/shared';

import { Card, Empty, Facts, Pill, Table } from '@/components/ui';
import { date, dateTime, percent, words, type Tone } from '@/lib/format';

/**
 * Data connections as an operator sees them: how each was made, its trust tier and health,
 * what the platform or bank reported about the account, the snapshots each decision read
 * (time, hash prefix, counts), and the veracity findings with their evidence. No token is
 * ever part of what the API returns.
 */

const TIER_TONE: Record<TrustTier, Tone> = {
  HIGH: 'good',
  MEDIUM: 'info',
  LOW: 'warn',
  NONE: 'neutral',
};
const HEALTH_TONE: Record<string, Tone> = {
  HEALTHY: 'good',
  PENDING: 'warn',
  REAUTH_REQUIRED: 'bad',
  ERROR: 'bad',
  REVOKED: 'neutral',
};
const CONSEQUENCE_TONE: Record<string, Tone> = {
  KNOCKOUT: 'bad',
  NEEDS_INFO: 'warn',
  REFER: 'warn',
  CAP: 'warn',
  EXCLUDE_SOURCE: 'info',
  REDUCE_DEPTH: 'info',
  INFORM: 'neutral',
};

function ConnectionCard({ c, tier }: { c: OperatorConnection; tier: TrustTier | null }) {
  const id = c.identity;
  return (
    <Card
      title={`${c.name} · ${c.detail}`}
      aside={
        <>
          <Pill tone={HEALTH_TONE[c.health] ?? 'neutral'}>{words(c.health)}</Pill>{' '}
          <Pill tone={TIER_TONE[tier ?? c.methodTier]}>{`Tier ${tier ?? c.methodTier}`}</Pill>
        </>
      }
    >
      <Facts
        wide
        rows={[
          ['Method', `${words(c.accessMethod)} (${c.provider})`],
          ['Method tier', c.methodTier],
          c.kind === 'BANK'
            ? [
                'Bank authorized (OAuth)',
                id.institutionAuthorized === null
                  ? 'Unknown'
                  : id.institutionAuthorized
                    ? 'Yes'
                    : 'No, legacy',
              ]
            : null,
          c.kind === 'BANK'
            ? ['Account holder (bank)', id.ownerNames.join(', ') || 'Not reported']
            : null,
          c.kind === 'BANK' ? ['Account type', id.accountType ?? 'Not reported'] : null,
          c.kind === 'BANK'
            ? ['Opened', id.accountCreatedOn ? date(id.accountCreatedOn) : 'Not reported']
            : null,
          c.kind === 'BANK'
            ? [
                'Accounts on the login',
                id.otherAccounts
                  .map((a) => `${a.name} ...${a.mask}${a.shared ? ' (shared)' : ' (not shared)'}`)
                  .join(', ') || 'Not reported',
              ]
            : null,
          c.kind === 'COMMERCE' ? ['Legal name (platform)', id.legalName ?? 'Not reported'] : null,
          c.kind === 'COMMERCE'
            ? ['Tax id (platform)', id.taxIdLast4 ? `ends ${id.taxIdLast4}` : 'Not reported']
            : null,
          c.kind === 'COMMERCE'
            ? [
                'Platform account',
                `${id.platformAccountId ?? 'n/a'}${id.country ? `, ${id.country}` : ''}`,
              ]
            : null,
          c.kind === 'COMMERCE'
            ? ['Account created', id.accountCreatedOn ? date(id.accountCreatedOn) : 'Not reported']
            : null,
          c.kind === 'COMMERCE'
            ? [
                'Pays out to',
                id.payoutDestinations
                  .map((d) => `${d.institutionName ?? 'bank'} ...${d.mask ?? '?'}`)
                  .join(', ') || 'Not reported',
              ]
            : null,
          id.serviceUser ? ['Seat (CashFlow service user)', id.serviceUser] : null,
          ['Scopes', c.scopes.join(', ') || 'None recorded'],
          [
            'Token',
            c.hasStoredToken
              ? `Stored, encrypted${c.tokenExpiresAt ? `, expires ${dateTime(c.tokenExpiresAt)}` : ''}`
              : 'None stored',
          ],
          ['Last pull', c.lastPulledAt ? dateTime(c.lastPulledAt) : 'Never'],
          c.lastPullError ? ['Last error', c.lastPullError] : null,
          c.revokedAt ? ['Revoked', dateTime(c.revokedAt)] : null,
        ]}
      />
      {c.snapshots.length === 0 ? (
        <Empty title="No snapshots" />
      ) : (
        <Table
          head={['Pulled', 'Reason', 'Window', 'Hash', { num: 'Records' }, { num: 'Bytes' }]}
          caption={`Snapshots of ${c.name}`}
        >
          {c.snapshots.map((s) => (
            <tr key={s.id}>
              <td>{dateTime(s.pulledAt)}</td>
              <td>{words(s.reason)}</td>
              <td>
                {date(s.windowFrom)} to {date(s.windowTo)}
              </td>
              <td>
                <code title={s.contentHash}>{s.hashPrefix}</code>
              </td>
              <td className="num">
                {Object.entries(s.recordCounts)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(', ')}
              </td>
              <td className="num">{s.payloadBytes.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function evidence(f: VeracityFinding): string {
  return Object.entries(f.evidence)
    .map(([k, v]) => `${k}: ${v === null ? 'n/a' : String(v)}`)
    .join(' · ');
}

export function ConnectionsPanel({ data }: { data: OperatorConnections }) {
  const v = data.assessment?.veracity ?? null;
  const tierOf = (id: string) => v?.sources.find((s) => s.connectionId === id)?.trustTier ?? null;
  return (
    <>
      <Card
        title="Data veracity"
        aside={
          v ? (
            <Pill
              tone={
                CONSEQUENCE_TONE[v.overall.outcome] ??
                (v.overall.outcome === 'CLEAR' ? 'good' : 'neutral')
              }
            >
              {words(v.overall.outcome)}
            </Pill>
          ) : undefined
        }
      >
        {!v || !data.assessment ? (
          <Empty title="No assessment yet">
            No decision on this business has run the veracity checks.
          </Empty>
        ) : (
          <>
            <Facts
              rows={[
                [
                  'Assessed',
                  `${dateTime(data.assessment.decidedAt)} (${words(data.assessment.kind)}, ${data.assessment.policyVersion})`,
                ],
                ['Best usable tier', v.overall.trustTier],
                ['Independently verified sources', String(v.overall.independentlyVerifiedSources)],
                [
                  'Snapshots read',
                  v.snapshots
                    .map((s) => `${words(s.kind)} ${s.contentHash.slice(0, 12)}`)
                    .join(', ') || 'None recorded',
                ],
              ]}
            />
            {v.reconciliation.map((r) => (
              <Facts
                key={r.connectionId ?? 'pos'}
                rows={[
                  [
                    'Payouts reconciled',
                    `${r.matchedCount} of ${r.payoutsConsidered} (${percent(r.matchedShareByCountBps)} by count, ${percent(r.matchedShareByAmountBps)} by amount)`,
                  ],
                  ['Payouts to unconnected accounts', `${r.unlinkedPayouts}`],
                  [
                    'Deposits naming the platform without a payout',
                    `${r.claimedUnmatchedDeposits}`,
                  ],
                  ['Payouts over card sales', percent(r.payoutToCardSalesBps)],
                ]}
              />
            ))}
            {v.findings.length === 0 ? (
              <Empty title="No findings" />
            ) : (
              <Table
                head={['Finding', 'Consequence', 'Source', 'What was found', 'Evidence']}
                caption="Veracity findings"
              >
                {v.findings.map((f, i) => (
                  <tr key={`${f.code}-${i}`}>
                    <td>
                      <code>{f.code}</code>
                    </td>
                    <td>
                      <Pill tone={CONSEQUENCE_TONE[f.consequence] ?? 'neutral'}>
                        {words(f.consequence)}
                      </Pill>
                      {f.excludesSource ? ' source excluded' : ''}
                    </td>
                    <td>{words(f.source)}</td>
                    <td>{f.detail}</td>
                    <td className="muted">{evidence(f)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Card>
      {data.connections.length === 0 ? (
        <Card title="Connections">
          <Empty title="Nothing connected" />
        </Card>
      ) : (
        data.connections.map((c) => <ConnectionCard key={c.id} c={c} tier={tierOf(c.id)} />)
      )}
    </>
  );
}
