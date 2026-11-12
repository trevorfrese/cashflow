import type { AdverseActionNoticeView, DecisionExplanation } from '@cashflow/shared';

import { Card, Empty, Pill, Table } from '@/components/ui';
import { date, dateTime } from '@/lib/format';
import { FACTOR_STATUS, NOTICE_KINDS, reasonTitle } from '@/lib/labels';

/**
 * What the applicant sees: the explanation built from the stored decision, exactly as the
 * app shows it, and every notice sent with its full text as delivered.
 */

export function ExplanationCard({ explanation: e }: { explanation: DecisionExplanation | null }) {
  if (!e) return null;
  return (
    <Card title="What the applicant is told" aside={<Pill tone="info">{e.headline}</Pill>}>
      <p>{e.summary}</p>
      {e.score ? (
        <p className="small">
          Shown with the score: {e.score.value} of 100, grade {e.score.grade}.
        </p>
      ) : (
        <p className="small muted">No score is shown to the applicant for this outcome.</p>
      )}
      {e.nextSteps ? <p className="small">{e.nextSteps.text}</p> : null}
      {e.principalReasons.length > 0 || e.requestedInformation.length > 0 ? (
        <div>
          <h3 className="sub">
            {e.principalReasons.length > 0 ? 'Principal reasons, in order' : 'What we asked for'}
          </h3>
          <ol>
            {[...e.principalReasons, ...e.requestedInformation].map((r) => (
              <li key={r.code}>
                <strong>{r.title}.</strong> {r.text}
                <div className="muted small">What would change this: {r.guidance}</div>
                <div className="muted small mono">{r.code}</div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {e.factors.length > 0 ? (
        <Table caption="Factors as the applicant sees them" head={['Factor', 'Status', 'Finding']}>
          {e.factors.map((f) => (
            <tr key={f.code}>
              <td className="cell-main">{f.label}</td>
              <td>
                <Pill tone={FACTOR_STATUS[f.status].tone}>{FACTOR_STATUS[f.status].label}</Pill>
              </td>
              <td>{f.detail}</td>
            </tr>
          ))}
        </Table>
      ) : null}
      {e.checks.length > 0 ? (
        <Table caption="Checks that ran" head={['Check', 'Result', 'Detail']}>
          {e.checks.map((c) => (
            <tr key={c.code}>
              <td className="cell-main">{c.label}</td>
              <td>
                <Pill tone={c.passed ? 'good' : 'bad'}>{c.passed ? 'Passed' : 'Failed'}</Pill>
              </td>
              <td>{c.detail}</td>
            </tr>
          ))}
        </Table>
      ) : null}
      {e.dataSources.length > 0 ? (
        <p className="small muted">
          Data read:{' '}
          {e.dataSources
            .map((s) => `${s.name}${s.dataAsOf ? ` (as of ${date(s.dataAsOf)})` : ''}`)
            .join('; ')}
          .
        </p>
      ) : null}
    </Card>
  );
}

export function NoticesCard({ notices }: { notices: readonly AdverseActionNoticeView[] }) {
  return (
    <Card title="Notices sent" aside={`${notices.length} sent`}>
      {notices.length === 0 ? (
        <Empty title="No notices">
          Nothing has been sent. A decline sends one at once; a counter offer when it is declined or
          expires; an incomplete application after a wait.
        </Empty>
      ) : (
        <Table
          caption="Adverse action notices and notices of incompleteness"
          head={['Notice', 'Delivered', 'Deadline', 'Reasons', 'Text']}
        >
          {notices.map((n) => (
            <tr key={n.id}>
              <td>
                <div className="cell-main">{NOTICE_KINDS[n.kind]}</div>
                <div className="muted small">{n.title}</div>
                {n.late ? <Pill tone="bad">Late</Pill> : null}{' '}
                {n.isAdverseAction ? null : <Pill tone="info">Not adverse action</Pill>}
              </td>
              <td className="nowrap">
                {dateTime(n.deliveredAt)}
                <div className="muted small">
                  {n.channel === 'IN_APP' ? 'In the app' : n.channel}
                </div>
              </td>
              <td className="nowrap">
                {date(n.deadlineOn)}
                {n.respondBy ? (
                  <div className="muted small">Respond by {date(n.respondBy)}</div>
                ) : null}
              </td>
              <td>{n.principalReasons.map((r) => reasonTitle(r.code)).join('; ')}</td>
              <td>
                <details className="payload">
                  <summary>Full text ({n.statementVersion})</summary>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{n.text}</pre>
                </details>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
