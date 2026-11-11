import type { AlertSeverity } from '@cashflow/shared';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import type { ApiError } from '@/lib/api';
import type { Tone } from '@/lib/format';
import { refusal, SEVERITY, status as statusTag } from '@/lib/labels';

/**
 * The console's pieces of the product design system: the same ink borders, hard shadows,
 * and tag tones as the mobile app's Card, Button, Pill, and Notice, sized for a dense
 * desktop tool. Styles are in app/globals.css.
 */

export function Card({
  title,
  aside,
  children,
  tone,
  id,
}: {
  title?: ReactNode;
  /** Right side of the header: a count, a tag, a small action. */
  aside?: ReactNode;
  children: ReactNode;
  tone?: 'gold' | 'canvas';
  id?: string;
}) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`} id={id}>
      {(title || aside) && (
        <header className="card-head">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {aside ? <div className="card-aside">{aside}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

type ButtonVariant = 'azure' | 'gold' | 'plain' | 'danger';

export function Button({
  variant = 'plain',
  small = false,
  busy = false,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant}${small ? ' btn-small' : ''}${rest.className ? ` ${rest.className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? 'Working...' : children}
    </button>
  );
}

/** A flat status tag. No border or shadow, so it never reads as a button. */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function StatusPill({ code }: { code: string | null | undefined }) {
  const tag = statusTag(code);
  return <Pill tone={tag.tone}>{tag.label}</Pill>;
}

/**
 * Severity as a tag with its name and a four step level meter, so it reads without color:
 * the word says which level, the meter says how far up the scale.
 */
export function SeverityPill({ severity }: { severity: AlertSeverity }) {
  const s = SEVERITY[severity];
  return (
    <span className={`sev sev-${severity.toLowerCase()}`}>
      <span className="sev-meter" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span key={step} className={step <= s.level ? 'on' : ''} />
        ))}
      </span>
      {s.label}
    </span>
  );
}

const GLYPH: Record<string, string> = { info: 'i', bad: '!', good: 'OK', warn: '!' };

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'bad' | 'good' | 'warn';
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <span className="notice-glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <div>
        {title ? <p className="notice-title">{title}</p> : null}
        {children ? <div className="notice-body">{children}</div> : null}
      </div>
    </div>
  );
}

/** An API refusal as a specific, actionable message. */
export function Refusal({ error }: { error: ApiError | undefined }) {
  if (!error) return null;
  const r = refusal(error);
  return (
    <Notice tone="bad" title={r.title}>
      <p>{r.body}</p>
      {r.href ? (
        <p>
          <Link href={r.href}>{r.link}</Link>
        </p>
      ) : null}
      <p className="muted small">Code: {error.code}</p>
    </Notice>
  );
}

export function Stat({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  tone?: Tone;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </>
  );
  const className = `stat${tone ? ` stat-${tone}` : ''}`;
  return href ? (
    <Link className={`${className} stat-link`} href={href}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Label and value pairs. `wide` gives values the room for a sentence. */
export function Facts({
  rows,
  wide = false,
}: {
  rows: Array<[label: ReactNode, value: ReactNode] | null | false | undefined>;
  wide?: boolean;
}) {
  return (
    <dl className={`facts${wide ? ' facts-wide' : ''}`}>
      {rows.map((row, i) =>
        row ? (
          <div key={i}>
            <dt>{row[0]}</dt>
            <dd>{row[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

/** A column heading. `{ num: 'Amount' }` is a numeric column: its heading is right aligned. */
export type Heading = ReactNode | { num: string };

const isNumeric = (h: Heading): h is { num: string } =>
  typeof h === 'object' && h !== null && 'num' in h;

/** A table that scrolls sideways inside its own box on a narrow screen. */
export function Table({
  head,
  children,
  caption,
}: {
  head: Heading[];
  children: ReactNode;
  caption: string;
}) {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) =>
              isNumeric(h) ? (
                <th key={i} scope="col" className="num">
                  {h.num}
                </th>
              ) : (
                <th key={i} scope="col">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}

/** Placeholder with a fixed height, so content arriving does not move the page. */
export function Skeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

export function LoadError({ error, retry }: { error: ApiError; retry: () => void }) {
  const r = refusal(error);
  return (
    <Notice
      tone="bad"
      title={error.status >= 500 || error.status === 0 ? r.title : 'Could not load this'}
    >
      <p>{r.body}</p>
      <p>
        <Button small onClick={retry}>
          Try again
        </Button>
      </p>
    </Notice>
  );
}

/**
 * The three states of a loaded resource: a skeleton on first load, an error with a retry,
 * or the content. While reloading, the content stays and is marked busy.
 */
export function Load<T>({
  from,
  rows,
  children,
}: {
  from: { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void };
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (from.data !== undefined) {
    return (
      <div
        aria-busy={from.loading || undefined}
        className={from.loading ? 'stack reloading' : 'stack'}
      >
        {from.error ? <LoadError error={from.error} retry={from.reload} /> : null}
        {children(from.data)}
      </div>
    );
  }
  if (from.error) return <LoadError error={from.error} retry={from.reload} />;
  return <Skeleton rows={rows} />;
}

export function PageHead({
  title,
  lead,
  actions,
  back,
}: {
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="page-head">
      <div>
        {back ? (
          <Link className="back" href={back.href}>
            <span aria-hidden="true">&larr;</span> {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  required,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required ? <span className="req"> (required)</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-message" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A share drawn against its cap: the bar is the share, the tick is the cap. */
export function CapBar({
  shareBps,
  capBps,
  label,
}: {
  shareBps: number | null;
  capBps: number;
  label: string;
}) {
  // The track runs to twice the cap or 100%, whichever is smaller, so the cap tick is visible.
  const scale = Math.min(10_000, Math.max(capBps * 2, 1));
  const width = shareBps === null ? 0 : Math.min(100, (shareBps / scale) * 100);
  const tick = Math.min(100, (capBps / scale) * 100);
  const over = shareBps !== null && shareBps > capBps;
  return (
    <span className={`capbar${over ? ' capbar-over' : ''}`} role="img" aria-label={label}>
      <span className="capbar-fill" style={{ width: `${width}%` }} />
      <span className="capbar-tick" style={{ left: `${tick}%` }} />
    </span>
  );
}
