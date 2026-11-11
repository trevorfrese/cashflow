import { createHash } from 'node:crypto';

import type {
  BusinessVerificationInput,
  IdentityProvider,
  OwnerVerificationInput,
  OwnerVerificationResult,
  ScreeningInput,
  ScreeningOutput,
  ScreeningStatus,
  VerificationResult,
} from './types.ts';

/**
 * Sandbox identity provider. Deterministic: the answer depends only on the input, so demos
 * and tests are repeatable. Everything verifies and screens clear unless a name carries one
 * of these keywords (case insensitive, anywhere in the name):
 *
 *   Verification, in a business legal name, trade name, or an owner's name:
 *     unverifiable   FAILED   (reason ENTITY_NOT_FOUND, or IDENTITY_NOT_FOUND for an owner)
 *     mismatch       REVIEW   (reason NAME_ADDRESS_MISMATCH, or IDENTITY_MISMATCH for an owner)
 *   Verification, from the other fields of a business:
 *     tax id last 4 of 0000   REVIEW  (reason TAX_ID_MISMATCH)
 *     no tax id at all        REVIEW  (reason TAX_ID_MISSING)
 *   Verification of owners:
 *     no owners at all        the caller records REVIEW with reason OWNERS_MISSING
 *
 *   Screening, in any name or alias (business, owner, landlord, payout account holder):
 *     sanctioned     MATCH
 *     watchlist      POSSIBLE_MATCH
 *
 * No network, no vendor, no stored personal data.
 */
export const MOCK_IDENTITY_KEYWORDS = {
  verificationFailed: 'unverifiable',
  verificationReview: 'mismatch',
  taxIdReview: '0000',
  screeningMatch: 'sanctioned',
  screeningPossibleMatch: 'watchlist',
} as const;

const digest = (...parts: string[]) =>
  createHash('sha256').update(parts.join('|').toLowerCase()).digest('hex').slice(0, 16);

const has = (text: string, keyword: string) => text.toLowerCase().includes(keyword);

export class MockIdentityProvider implements IdentityProvider {
  readonly name = 'mock';

  async verifyBusiness(input: BusinessVerificationInput): Promise<VerificationResult> {
    const names = `${input.legalName} ${input.dba ?? ''}`;
    const reference = `mock_kyb_${digest(input.legalName, input.address.postalCode, input.taxIdLast4 ?? '')}`;
    if (has(names, MOCK_IDENTITY_KEYWORDS.verificationFailed)) {
      return { status: 'FAILED', reasons: ['ENTITY_NOT_FOUND'], reference };
    }
    const reasons: string[] = [];
    if (has(names, MOCK_IDENTITY_KEYWORDS.verificationReview)) {
      reasons.push('NAME_ADDRESS_MISMATCH');
    }
    if (input.taxIdLast4 === null) reasons.push('TAX_ID_MISSING');
    else if (input.taxIdLast4 === MOCK_IDENTITY_KEYWORDS.taxIdReview) {
      reasons.push('TAX_ID_MISMATCH');
    }
    return { status: reasons.length > 0 ? 'REVIEW' : 'VERIFIED', reasons, reference };
  }

  async verifyOwners(owners: OwnerVerificationInput[]): Promise<OwnerVerificationResult[]> {
    return owners.map((owner) => {
      const reference = `mock_kyc_${digest(owner.fullName, owner.title)}`;
      if (has(owner.fullName, MOCK_IDENTITY_KEYWORDS.verificationFailed)) {
        return {
          ownerId: owner.ownerId,
          status: 'FAILED',
          reasons: ['IDENTITY_NOT_FOUND'],
          reference,
        };
      }
      if (has(owner.fullName, MOCK_IDENTITY_KEYWORDS.verificationReview)) {
        return {
          ownerId: owner.ownerId,
          status: 'REVIEW',
          reasons: ['IDENTITY_MISMATCH'],
          reference,
        };
      }
      return { ownerId: owner.ownerId, status: 'VERIFIED', reasons: [], reference };
    });
  }

  async screenParty(input: ScreeningInput): Promise<ScreeningOutput> {
    const names = [input.name, ...(input.aliases ?? [])].join(' ');
    const result: ScreeningStatus = has(names, MOCK_IDENTITY_KEYWORDS.screeningMatch)
      ? 'MATCH'
      : has(names, MOCK_IDENTITY_KEYWORDS.screeningPossibleMatch)
        ? 'POSSIBLE_MATCH'
        : 'CLEAR';
    // The reference depends on the names and the result only, so the same hit on the same
    // party comes back with the same reference on every rescreen.
    const prefix = result === 'CLEAR' ? 'mock_search' : 'mock_match';
    return { result, matchReference: `${prefix}_${digest(names, result, input.country ?? '')}` };
  }
}
