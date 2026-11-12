import {
  formatCents,
  type AdverseActionNoticeKind,
  type IsoDate,
  type PrincipalReason,
} from '@cashflow/shared';

import { CREDITOR, ECOA_STATEMENT, NOTICE_STATEMENT_VERSION } from './policy.ts';

/**
 * The notice template. Pure: the same facts render the same text, which is stored as
 * delivered. Plain text, so the in-app screen, an email and a printed letter can all carry
 * it unchanged.
 *
 * What every adverse action notice carries (12 CFR 1002.9(a)(2) and (b)):
 *   - a statement of the action taken,
 *   - the creditor's name and address,
 *   - the ECOA statement of 1002.9(b)(1), with the federal agency,
 *   - the specific principal reasons (1002.9(b)(2)), always in writing, whatever the
 *     business's revenue (the conservative reading of 1002.9(a)(3)).
 */

export interface NoticeFacts {
  kind: AdverseActionNoticeKind;
  businessName: string;
  applicationId: string;
  requestedMonthlyRentCents: number;
  /** The date on the notice. */
  noticeOn: IsoDate;
  principalReasons: readonly PrincipalReason[];
  /** Counter offer notices: what was offered and when, and whether the applicant declined. */
  offer?: { limitCents: number; offeredOn: IsoDate; declinedByApplicant: boolean } | null;
  /** Notices of incompleteness, and the closing notice after one. */
  incomplete?: { askedOn: IsoDate; respondBy: IsoDate } | null;
}

export interface RenderedNotice {
  title: string;
  text: string;
  statementVersion: string;
}

export const NOTICE_TITLES: Record<AdverseActionNoticeKind, string> = {
  DECLINE: 'Notice of action taken',
  COUNTER_OFFER_NOT_ACCEPTED: 'Notice of action taken on your counter offer',
  INCOMPLETE: 'Notice of incomplete application',
  INCOMPLETE_DECLINED: 'Notice of action taken: application incomplete',
};

/** A notice of incompleteness asks for information; the others record adverse action. */
export function isAdverseAction(kind: AdverseActionNoticeKind): boolean {
  return kind !== 'INCOMPLETE';
}

const usd = (cents: number) => formatCents(cents, { showCents: false });

/** "November 12, 2026", in UTC so the date never shifts with the server's zone. */
export function longDate(date: IsoDate): string {
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function reasonList(reasons: readonly PrincipalReason[]): string[] {
  return reasons.flatMap((r, i) => [
    `${i + 1}. ${r.title}. ${r.text}`,
    `   What would change this: ${r.guidance}`,
  ]);
}

export function renderNotice(f: NoticeFacts): RenderedNotice {
  if (f.principalReasons.length === 0) {
    throw new Error(`A ${f.kind} notice needs at least one principal reason`);
  }
  const title = NOTICE_TITLES[f.kind];
  const lines: string[] = [
    title.toUpperCase(),
    longDate(f.noticeOn),
    '',
    `To: ${f.businessName}`,
    `Application: ${f.applicationId}`,
    `From: ${CREDITOR.name}, ${CREDITOR.address}`,
    '',
  ];

  switch (f.kind) {
    case 'DECLINE':
      lines.push(
        `Thank you for applying to have us pay your rent of ${usd(f.requestedMonthlyRentCents)} a month. We have reviewed your application and we are unable to approve it.`,
        '',
        'The principal reasons for our decision:',
        ...reasonList(f.principalReasons),
      );
      break;
    case 'COUNTER_OFFER_NOT_ACCEPTED': {
      const offer = f.offer!;
      lines.push(
        `You applied to have us pay your rent of ${usd(f.requestedMonthlyRentCents)} a month. On ${longDate(offer.offeredOn)} we could not approve that amount and offered instead to pay up to ${usd(offer.limitCents)} a month.`,
        offer.declinedByApplicant
          ? 'You declined that offer, so we have not approved your application for the amount you asked for.'
          : 'That offer was not taken up before it expired, so we have not approved your application for the amount you asked for.',
        '',
        'The principal reasons we could not approve the amount you asked for:',
        ...reasonList(f.principalReasons),
      );
      break;
    }
    case 'INCOMPLETE': {
      const inc = f.incomplete!;
      lines.push(
        'We cannot finish reviewing your application yet, because we still need the following:',
        ...reasonList(f.principalReasons),
        '',
        `Please provide it by ${longDate(inc.respondBy)}. When you have, open the app and run the decision again. If we do not have it by then, we will close the application as incomplete and send you a notice saying so. You can apply again at any time after that.`,
      );
      break;
    }
    case 'INCOMPLETE_DECLINED': {
      const inc = f.incomplete!;
      lines.push(
        `On ${longDate(inc.askedOn)} we asked for information we needed to finish your application, and asked for it by ${longDate(inc.respondBy)}. We did not receive it, so we have closed your application as incomplete and could not approve it.`,
        '',
        'The principal reasons for our decision:',
        ...reasonList(f.principalReasons),
      );
      break;
    }
  }

  lines.push(
    '',
    'You may apply again at any time. If you have questions about this notice, contact us at ' +
      `${CREDITOR.contact}.`,
    '',
    ECOA_STATEMENT,
  );
  if (CREDITOR.isPlaceholder) {
    lines.push(
      '',
      'This notice was produced by a sandbox. The creditor details marked as placeholders are not a real company.',
    );
  }
  return { title, text: lines.join('\n'), statementVersion: NOTICE_STATEMENT_VERSION };
}
