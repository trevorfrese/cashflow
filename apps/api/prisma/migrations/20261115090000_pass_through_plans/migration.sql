-- Pass-through rent plans, graduation offers, and one landlord payment per lease and month.
--
-- Every existing plan is FINANCED. A pass-through plan collects the business's rent before
-- the due date and pays the landlord only once the collection has settled, through the
-- landlord_payable liability: CashFlow never advances its own money on one.
--
-- LandlordDisbursement records every payment of rent to a landlord, whichever plan made it.
-- The partial unique index below allows one SENT row per lease and period month, and the
-- services write the row before calling the payments provider, in the same transaction. That
-- closes the double-pay hazard on a released payout at the database level.

-- AlterEnum
ALTER TYPE "DecisionKind" ADD VALUE IF NOT EXISTS 'ELIGIBILITY_REVIEW';
ALTER TYPE "DecisionKind" ADD VALUE IF NOT EXISTS 'GRADUATION';

-- CreateEnum
CREATE TYPE "RentPlanKind" AS ENUM ('FINANCED', 'PASS_THROUGH');

-- CreateEnum
CREATE TYPE "PassThroughPeriodStatus" AS ENUM ('SCHEDULED', 'COLLECTING', 'SETTLED', 'PAID', 'MISSED', 'REFUNDED', 'RETURNED_AFTER_PAYOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GraduationOfferStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'COMPLETED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('SENT', 'RETURNED');

-- AlterTable
ALTER TABLE "RentPlan" ADD COLUMN     "kind" "RentPlanKind" NOT NULL DEFAULT 'FINANCED';

-- CreateTable
CREATE TABLE "PassThroughPeriod" (
    "id" TEXT NOT NULL,
    "rentPlanId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "collectOn" TEXT NOT NULL,
    "lastCollectOn" TEXT NOT NULL,
    "status" "PassThroughPeriodStatus" NOT NULL DEFAULT 'SCHEDULED',
    "collectionAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptOn" TEXT,
    "collectionSkipReason" TEXT,
    "collectionSkippedOn" TEXT,
    "collectedOn" TEXT,
    "collectionProviderRef" TEXT,
    "collectionBankLinkId" TEXT,
    "settlesOn" TEXT,
    "settledOn" TEXT,
    "paidOn" TEXT,
    "paidAt" TIMESTAMP(3),
    "payoutProviderRef" TEXT,
    "heldReason" TEXT,
    "heldAt" TIMESTAMP(3),
    "missedReason" TEXT,
    "returnCode" TEXT,
    "returnedOn" TEXT,
    "refundedOn" TEXT,
    "refundProviderRef" TEXT,
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassThroughPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraduationOffer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "passThroughPlanId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "status" "GraduationOfferStatus" NOT NULL DEFAULT 'OFFERED',
    "approvedMonthlyLimitCents" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "installmentsPerMonth" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "onTimeMonths" INTEGER NOT NULL,
    "offeredOn" TEXT NOT NULL,
    "expiresOn" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedOn" TEXT,
    "effectivePeriod" TEXT,
    "financedPlanId" TEXT,
    "completedAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraduationOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandlordDisbursement" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "rentPlanId" TEXT NOT NULL,
    "kind" "RentPlanKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'SENT',
    "providerRef" TEXT,
    "effectiveDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),

    CONSTRAINT "LandlordDisbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentPlan_kind_status_idx" ON "RentPlan"("kind", "status");

-- CreateIndex
CREATE INDEX "PassThroughPeriod_status_dueDate_idx" ON "PassThroughPeriod"("status", "dueDate");

-- CreateIndex
CREATE INDEX "PassThroughPeriod_collectionProviderRef_idx" ON "PassThroughPeriod"("collectionProviderRef");

-- CreateIndex
CREATE UNIQUE INDEX "PassThroughPeriod_rentPlanId_periodMonth_key" ON "PassThroughPeriod"("rentPlanId", "periodMonth");

-- CreateIndex
CREATE INDEX "GraduationOffer_businessId_status_idx" ON "GraduationOffer"("businessId", "status");

-- CreateIndex
CREATE INDEX "GraduationOffer_status_expiresOn_idx" ON "GraduationOffer"("status", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "LandlordDisbursement_idempotencyKey_key" ON "LandlordDisbursement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LandlordDisbursement_leaseId_periodMonth_idx" ON "LandlordDisbursement"("leaseId", "periodMonth");

-- CreateIndex
CREATE INDEX "LandlordDisbursement_sourceId_idx" ON "LandlordDisbursement"("sourceId");

-- AddForeignKey
ALTER TABLE "PassThroughPeriod" ADD CONSTRAINT "PassThroughPeriod_rentPlanId_fkey" FOREIGN KEY ("rentPlanId") REFERENCES "RentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraduationOffer" ADD CONSTRAINT "GraduationOffer_passThroughPlanId_fkey" FOREIGN KEY ("passThroughPlanId") REFERENCES "RentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandlordDisbursement" ADD CONSTRAINT "LandlordDisbursement_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One landlord payment per lease and period month, across plans and kinds. A payment that
-- came back from the landlord's bank is RETURNED and no longer counts, so a reviewer can
-- send it again.
CREATE UNIQUE INDEX "LandlordDisbursement_one_per_period" ON "LandlordDisbursement"("leaseId", "periodMonth") WHERE "status" = 'SENT';

-- One open graduation offer per pass-through plan.
CREATE UNIQUE INDEX "GraduationOffer_one_open_per_plan" ON "GraduationOffer"("passThroughPlanId") WHERE "status" IN ('OFFERED', 'ACCEPTED');

-- Backfill: every landlord payout already paid is a disbursement, so a period paid before
-- this migration cannot be paid again after it.
INSERT INTO "LandlordDisbursement" ("id", "leaseId", "periodMonth", "rentPlanId", "kind", "sourceId", "idempotencyKey", "amountCents", "status", "providerRef", "effectiveDate", "createdAt")
SELECT
  'ld_' || p."id",
  r."leaseId",
  p."periodMonth",
  p."rentPlanId",
  'FINANCED',
  p."id",
  CASE WHEN p."resendCount" = 0 THEN 'payout:' || p."id" ELSE 'payout:' || p."id" || ':resend:' || p."resendCount" END,
  p."amountCents",
  'SENT',
  p."providerRef",
  COALESCE(to_char(p."paidAt", 'YYYY-MM-DD'), p."scheduledFor"),
  COALESCE(p."paidAt", p."updatedAt")
FROM "LandlordPayout" p
JOIN "RentPlan" r ON r."id" = p."rentPlanId"
WHERE p."status" = 'PAID'
ON CONFLICT DO NOTHING;
