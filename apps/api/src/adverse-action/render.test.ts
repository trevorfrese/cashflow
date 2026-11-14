import { principalReason, findJargon } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { CREDITOR, ECOA_STATEMENT, NOTICE_STATEMENT_VERSION } from './policy.ts';
import { isAdverseAction, renderNotice, type NoticeFacts } from './render.ts';

const facts = (over: Partial<NoticeFacts> = {}): NoticeFacts => ({
  kind: 'DECLINE',
  businessName: 'Northside Barbers Inc',
  applicationId: 'app_123',
  requestedMonthlyRentCents: 350_000,
  noticeOn: '2026-11-12',
  principalReasons: [
    principalReason(
      'EXCESSIVE_OVERDRAFTS',
      '4 overdraft fees in the last 90 days. We allow at most 2.',
    ),
    principalReason('CASH_BUFFER'),
  ],
  ...over,
});

describe('renderNotice', () => {
  it('carries everything an adverse action notice must', () => {
    const { text, title, statementVersion } = renderNotice(facts());
    expect(title).toBe('Notice of action taken');
    expect(statementVersion).toBe(NOTICE_STATEMENT_VERSION);
    // The action, the creditor, the reasons in order, the ECOA statement and agency.
    expect(text).toContain('we are unable to approve it');
    expect(text).toContain(CREDITOR.name);
    expect(text).toContain(CREDITOR.address);
    expect(text).toContain('1. Overdraft fees. 4 overdraft fees in the last 90 days.');
    expect(text).toContain('2. Cash buffer.');
    expect(text).toContain('What would change this:');
    expect(text).toContain(ECOA_STATEMENT);
    expect(text).toContain('Federal Trade Commission');
    expect(text).toContain('November 12, 2026');
    expect(text).toContain('$3,500');
    // Placeholders are marked as such.
    expect(text).toContain('[PLACEHOLDER]');
  });

  it('is deterministic and free of internal terms and em dashes', () => {
    const a = renderNotice(facts());
    expect(renderNotice(facts())).toEqual(a);
    expect(a.text).not.toMatch(/\u2014/);
    for (const line of a.text.split('\n')) {
      if (line.includes('PLACEHOLDER')) continue;
      expect(findJargon(line), line).toBeNull();
    }
  });

  it('words a counter offer the owner declined, and one that expired', () => {
    const offer = { limitCents: 400_000, offeredOn: '2026-10-01', declinedByApplicant: true };
    const declined = renderNotice(
      facts({ kind: 'COUNTER_OFFER_NOT_ACCEPTED', requestedMonthlyRentCents: 600_000, offer }),
    ).text;
    expect(declined).toContain('offered instead to pay up to $4,000 a month');
    expect(declined).toContain('You declined that offer');
    const expired = renderNotice(
      facts({
        kind: 'COUNTER_OFFER_NOT_ACCEPTED',
        offer: { ...offer, declinedByApplicant: false },
      }),
    ).text;
    expect(expired).toContain('not taken up before it expired');
  });

  it('asks for what is missing on a notice of incompleteness, with a date', () => {
    const { text, title } = renderNotice(
      facts({
        kind: 'INCOMPLETE',
        principalReasons: [principalReason('BANK_LINK_REQUIRED')],
        incomplete: { askedOn: '2026-11-12', respondBy: '2026-12-12' },
      }),
    );
    expect(title).toBe('Notice of incomplete application');
    expect(text).toContain('Bank account needed');
    expect(text).toContain('Please provide it by December 12, 2026');
    expect(isAdverseAction('INCOMPLETE')).toBe(false);
    expect(isAdverseAction('INCOMPLETE_DECLINED')).toBe(true);
  });

  it('refuses to render an adverse action notice without a reason', () => {
    expect(() => renderNotice(facts({ principalReasons: [] }))).toThrow(/principal reason/);
  });
});

describe('notice references and the plan freeze notice', () => {
  it('prints a short reference number, never the raw application id', () => {
    const { text } = renderNotice(facts({ applicationId: 'cmh7x2k9q0001abcdef4f7a2c' }));
    expect(text).toContain('Reference number: 4F7A2C');
    expect(text).not.toContain('cmh7x2k9q0001abcdef4f7a2c');
    expect(text).not.toContain('Application:');
  });

  it('tells the owner what a freeze stops, what continues, and why', () => {
    const frozen = facts({
      kind: 'PLAN_FROZEN',
      principalReasons: [principalReason('ACCOUNT_HISTORY_NOT_VERIFIED')],
      frozen: { monthlyRentCents: 620_000, reviewedOn: '2026-11-12' },
    });
    const { text, title } = renderNotice(frozen);
    expect(title).toBe('Notice of action taken on your rent plan');
    expect(isAdverseAction('PLAN_FROZEN')).toBe(true);
    expect(text).toContain('we have stopped paying your landlord for new rent periods');
    expect(text).toContain('$6,200');
    expect(text).toContain('still collected on its schedule');
    expect(text).toContain('1. Account history.');
    expect(text).toContain(ECOA_STATEMENT);
    expect(text).not.toContain('You may apply again');
    expect(findJargon(text.replace(ECOA_STATEMENT, ''))).toBeNull();
    const held = renderNotice({
      ...frozen,
      principalReasons: [principalReason('PLAN_UNDER_REVIEW')],
      frozen: { monthlyRentCents: 620_000, reviewedOn: '2026-11-12', byOperator: true },
    });
    expect(held.text).toContain('a member of our team placed your plan');
  });
});
