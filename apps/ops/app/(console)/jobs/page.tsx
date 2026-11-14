'use client';

import { OperatorJobs } from '@cashflow/shared';

import { Button, Card, Empty, Load, Notice, PageHead, Pill, Table } from '@/components/ui';
import { date, dateTime, days, words } from '@/lib/format';
import { JOB_HEALTH } from '@/lib/labels';
import { useApi } from '@/lib/use-api';

function duration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Scheduled jobs: how each stands today and the recent run history. A job is late when its
 * last good run is older than the monitoring policy allows, the same measure the
 * `books.job_stale` rule alerts on. Read only: the console cannot run a job.
 */
export default function JobsPage() {
  const jobs = useApi('jobs', OperatorJobs);
  return (
    <>
      <PageHead
        title="Jobs"
        lead="The scheduled jobs: whether each ran when it should have, and the recent runs. Dates are the as-of date each run treated as today. Read only."
        actions={
          <Button small onClick={jobs.reload}>
            Refresh
          </Button>
        }
      />
      <Load from={jobs} rows={8}>
        {(j) => {
          const trouble = j.jobs.filter((x) => x.health === 'FAILED' || x.health === 'LATE');
          return (
            <>
              {trouble.length > 0 ? (
                <Notice
                  tone="bad"
                  title={`${trouble.length} ${trouble.length === 1 ? 'job needs' : 'jobs need'} a look`}
                >
                  <p>
                    {trouble.map((x) => words(x.name)).join(', ')}. A job that has not completed a
                    run in more than {days(j.maxGapDays)} is late. Jobs are idempotent for a date,
                    so an admin can run them again from the command line.
                  </p>
                </Notice>
              ) : null}
              <Card title="Every job" aside={<span className="muted">As of {date(j.asOf)}</span>}>
                <Table
                  caption="Health of every scheduled job"
                  head={[
                    'Job',
                    'Health',
                    'Last run',
                    'Ran for date',
                    'Last good date',
                    { num: 'Days since' },
                    { num: 'Recent runs' },
                    { num: 'Recent failures' },
                    'Last error',
                  ]}
                >
                  {j.jobs.map((x) => {
                    const health = JOB_HEALTH[x.health] ?? {
                      label: words(x.health),
                      tone: 'neutral' as const,
                    };
                    return (
                      <tr key={x.name}>
                        <td className="cell-main">{words(x.name)}</td>
                        <td>
                          <Pill tone={health.tone}>{health.label}</Pill>
                        </td>
                        <td className="nowrap">
                          {x.lastRun ? dateTime(x.lastRun.startedAt) : 'Never'}
                        </td>
                        <td className="nowrap">{x.lastRun ? date(x.lastRun.asOf) : '-'}</td>
                        <td className="nowrap">
                          {x.lastSuccessAsOf ? date(x.lastSuccessAsOf) : 'Never'}
                        </td>
                        <td className="num">{x.daysSinceSuccess ?? '-'}</td>
                        <td className="num">{x.recentRuns}</td>
                        <td className="num">{x.recentFailures}</td>
                        <td className="small">
                          {x.lastRun?.ok === false ? (
                            x.lastRun.error
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Table>
              </Card>
              <Card title="Recent runs" aside={<span className="muted">Newest first</span>}>
                {j.recent.length === 0 ? (
                  <Empty title="No job has run yet" />
                ) : (
                  <Table
                    caption="Recent job runs"
                    head={['Job', 'Ran for date', 'Started', 'Finished', { num: 'Took' }, 'Result']}
                  >
                    {j.recent.map((r) => (
                      <tr key={r.id}>
                        <td className="cell-main">{words(r.name)}</td>
                        <td className="nowrap">{date(r.asOf)}</td>
                        <td className="nowrap">{dateTime(r.startedAt)}</td>
                        <td className="nowrap">{r.finishedAt ? dateTime(r.finishedAt) : '-'}</td>
                        <td className="num">{duration(r.durationMs)}</td>
                        <td>
                          {r.ok === null ? (
                            <Pill tone="info">Running</Pill>
                          ) : r.ok ? (
                            <Pill tone="good">OK</Pill>
                          ) : (
                            <>
                              <Pill tone="bad">Failed</Pill>{' '}
                              <span className="small">{r.error}</span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            </>
          );
        }}
      </Load>
    </>
  );
}
