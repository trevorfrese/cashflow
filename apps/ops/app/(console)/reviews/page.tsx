'use client';

import { ReviewQueueItem } from '@cashflow/shared';
import Link from 'next/link';
import { z } from 'zod';

import { Button, Card, Empty, Load, PageHead, Pill, StatusPill, Table } from '@/components/ui';
import { date, days, deadline, money, percent } from '@/lib/format';
import { triggerLabel } from '@/lib/labels';
import { useApi } from '@/lib/use-api';

const Queue = z.array(ReviewQueueItem);

export default function ReviewQueuePage() {
  const queue = useApi('reviews', Queue);
  return (
    <>
      <PageHead
        title="Review queue"
        lead="Applications the engine referred to a person, oldest first. Each applicant must have an answer within 30 days of applying."
        actions={
          <Button small onClick={queue.reload}>
            Refresh
          </Button>
        }
      />
      <Card>
        <Load from={queue} rows={5}>
          {(items) =>
            items.length === 0 ? (
              <Empty title="Nothing is waiting for review">
                Referred applications appear here as the engine sends them.
              </Empty>
            ) : (
              <Table
                caption="Applications in review"
                head={[
                  'Business',
                  'Waiting',
                  'Answer due',
                  { num: 'Rent asked' },
                  'Engine recommends',
                  'Score',
                  'Why it was referred',
                ]}
              >
                {items.map((item) => {
                  const due = deadline(item.decisionDueOn);
                  return (
                    <tr key={item.applicationId}>
                      <td>
                        <Link className="cell-main" href={`/reviews/${item.applicationId}`}>
                          {item.businessName}
                        </Link>
                      </td>
                      <td className="nowrap">{days(item.ageDays)}</td>
                      <td>
                        <div className="nowrap">{date(item.decisionDueOn)}</div>
                        {due && due.tone !== 'neutral' ? (
                          <Pill tone={due.tone}>{due.label}</Pill>
                        ) : due ? (
                          <span className="muted small">{due.label}</span>
                        ) : null}
                      </td>
                      <td className="num">{money(item.requestedMonthlyRentCents)}</td>
                      <td>
                        <StatusPill code={item.recommendedOutcome} />
                        {item.recommendedMonthlyLimitCents !== null ? (
                          <div className="small nowrap">
                            {money(item.recommendedMonthlyLimitCents)} at{' '}
                            {percent(item.recommendedFeeBps)}
                          </div>
                        ) : null}
                      </td>
                      <td className="nowrap">
                        {item.score ?? '-'}
                        {item.grade ? ` (${item.grade})` : ''}
                      </td>
                      <td>
                        <ul className="plain">
                          {item.referTriggers.map((t) => (
                            <li key={t}>{triggerLabel(t)}</li>
                          ))}
                          {item.referTriggers.length === 0 ? (
                            <li className="muted">No trigger recorded</li>
                          ) : null}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )
          }
        </Load>
      </Card>
    </>
  );
}
