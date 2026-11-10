import { brand } from '@cashflow/shared';

import { CoinMark } from '@/components/CoinMark';

const GITHUB = brand.github;

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56C20.22 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

const STEPS = [
  {
    label: 'Day 1',
    title: 'Landlord paid in full',
    body: 'CashFlow pays the whole $10,000 to your landlord on the due date. Nothing changes on their side.',
  },
  {
    label: 'The 1st and 15th',
    title: 'You repay in two halves',
    body: '$5,000 comes out of your business account on the 1st and $5,000 on the 15th, plus a flat 1.5% fee.',
  },
  {
    label: 'No credit score',
    title: 'Underwritten on cash flow',
    body: 'Decisions come from your real bank activity, not a bureau. Instant, explainable, and open source.',
  },
];

export default function Home() {
  return (
    <main className="page">
      <header className="top">
        <a href="/" className="wordmark-small" aria-label="CashFlow home">
          <CoinMark size={32} decorative />
          CashFlow
        </a>
        <a className="button button-secondary button-sm" href={GITHUB} rel="noopener">
          <GitHubIcon />
          GitHub
        </a>
      </header>

      <section className="hero card">
        <div className="hero-art">
          <img
            src="/city-dusk.jpg"
            alt="A city skyline at dusk in flat poster colors"
            width={1024}
            height={1024}
          />
        </div>
        <div className="hero-body">
          <div className="lockup">
            <CoinMark size={120} title="CashFlow gold coin with a cents symbol" />
            <div>
              <p className="eyebrow">Split rent</p>
              <h1 className="wordmark">CashFlow</h1>
            </div>
          </div>
          <p className="tagline">
            Buy now, pay later for small business rent. Your landlord gets paid in full, you pay
            in two halves. Now an open source project.
          </p>
          <div className="actions">
            <a className="button button-primary button-lg" href={GITHUB} rel="noopener">
              View on GitHub
              <ArrowIcon />
            </a>
          </div>
        </div>
      </section>

      <section className="steps" aria-label="How it works">
        {STEPS.map((step) => (
          <article className="card step" key={step.title}>
            <p className="tag">{step.label}</p>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
          </article>
        ))}
      </section>

      <footer className="foot">
        <p>
          Built in public after the startup wound down. No real money moves in this code: every
          payment, bank, and capital provider runs in sandbox mode.
        </p>
        <a href={GITHUB} rel="noopener">
          github.com/trevorfrese/cashflow
        </a>
      </footer>
    </main>
  );
}
