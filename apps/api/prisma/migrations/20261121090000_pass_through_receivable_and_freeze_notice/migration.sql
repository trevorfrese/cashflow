-- A periodic review that freezes a running plan stores an adverse action notice: stopping
-- further advances is an unfavorable change to existing credit.
ALTER TYPE "AdverseActionNoticeKind" ADD VALUE 'PLAN_FROZEN';

-- A pass-through collection returned after the landlord was paid leaves the business owing
-- the rent. That receivable is a PAID landlord payout row (nothing is sent for it) with one
-- installment, linked to the pass-through period it came from, so it is collected, aged,
-- provisioned and charged off by the same servicing as a financed plan.
ALTER TABLE "LandlordPayout" ADD COLUMN "passThroughPeriodId" TEXT;
CREATE UNIQUE INDEX "LandlordPayout_passThroughPeriodId_key" ON "LandlordPayout"("passThroughPeriodId");
