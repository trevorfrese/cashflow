import type { IsoDate } from '@cashflow/shared';

/**
 * Identity verification and sanctions screening.
 *
 * Three questions, each answered by a vendor in production (a KYB and KYC service for the
 * first two, a sanctions and watchlist screening service for the third):
 *
 *   - Is this business what it says it is: does the legal name, address, tax id and
 *     formation date match a registered entity.
 *   - Are its beneficial owners real, identifiable people.
 *   - Does a name (the business, an owner, or a landlord we are about to pay) appear on a
 *     sanctions list or a watchlist.
 *
 * The interface carries the minimum a vendor needs and nothing we must not hold: the last
 * four digits of the tax id only, and for a person a name, a title and an ownership share.
 * No date of birth and no government id number passes through it. A real integration would
 * have the vendor collect those directly from the person and hand back the opaque
 * `reference` that is stored here.
 */

export type VerificationOutcome = 'VERIFIED' | 'REVIEW' | 'FAILED';

export interface VerificationResult {
  status: VerificationOutcome;
  /** Stable reason codes, for example `TAX_ID_MISMATCH`. Empty when verified. Internal. */
  reasons: string[];
  /** Opaque reference to the check at the provider. */
  reference: string;
}

export interface BusinessVerificationInput {
  legalName: string;
  dba?: string | null;
  address: {
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
  /** Null when the business has not given one. A provider treats that as REVIEW at best. */
  taxIdLast4: string | null;
  /** YYYY-MM-DD the business says it was formed. */
  formationDate: IsoDate;
}

export interface OwnerVerificationInput {
  /** Our id for the owner, echoed back so results can be matched up. */
  ownerId: string;
  fullName: string;
  title: string;
  ownershipBps: number;
}

export interface OwnerVerificationResult extends VerificationResult {
  ownerId: string;
}

export type ScreeningParty = 'BUSINESS' | 'OWNER' | 'LANDLORD';
export type ScreeningStatus = 'CLEAR' | 'POSSIBLE_MATCH' | 'MATCH';

export interface ScreeningInput {
  partyType: ScreeningParty;
  name: string;
  /** Other names for the same party: a trade name, or the holder of the payout account. */
  aliases?: string[];
  /** ISO 3166-1 alpha-2. Narrows the search when given. */
  country?: string;
}

export interface ScreeningOutput {
  result: ScreeningStatus;
  /**
   * The provider's reference for the match, stable for the same match on the same name, so
   * that a hit a reviewer has cleared is recognized when the party is screened again. For a
   * clear result it identifies the search.
   */
  matchReference: string;
}

export interface IdentityProvider {
  readonly name: string;
  verifyBusiness(input: BusinessVerificationInput): Promise<VerificationResult>;
  verifyOwners(owners: OwnerVerificationInput[]): Promise<OwnerVerificationResult[]>;
  screenParty(input: ScreeningInput): Promise<ScreeningOutput>;
}
