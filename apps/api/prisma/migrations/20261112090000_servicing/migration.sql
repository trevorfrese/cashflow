-- Phase R3: servicing, collections, charge-off.
--
-- Statuses that were never set are removed (PROCESSING, COLLECTING, PENDING): payments post
-- when they are made and are reversed by a new posting if the bank returns them. The USING
-- clauses map the removed values to the nearest live one in case a row somehow carries one.

-- CreateEnum
CREATE TYPE "DelinquencyStatus" AS ENUM ('CURRENT', 'GRACE', 'DELINQUENT', 'DEFAULT', 'CHARGED_OFF');

-- AlterEnum
BEGIN;
CREATE TYPE "InstallmentStatus_new" AS ENUM ('SCHEDULED', 'PAID', 'FAILED', 'LATE', 'CHARGED_OFF', 'VOIDED');
ALTER TABLE "public"."Installment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Installment" ALTER COLUMN "status" TYPE "InstallmentStatus_new" USING (
    (CASE WHEN "status"::text = 'COLLECTING' THEN 'SCHEDULED' ELSE "status"::text END)::"InstallmentStatus_new"
);
ALTER TYPE "InstallmentStatus" RENAME TO "InstallmentStatus_old";
ALTER TYPE "InstallmentStatus_new" RENAME TO "InstallmentStatus";
DROP TYPE "public"."InstallmentStatus_old";
ALTER TABLE "Installment" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "PayoutStatus_new" AS ENUM ('SCHEDULED', 'HELD', 'PAID', 'FAILED', 'CANCELLED');
ALTER TABLE "public"."LandlordPayout" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "LandlordPayout" ALTER COLUMN "status" TYPE "PayoutStatus_new" USING (
    (CASE WHEN "status"::text = 'PROCESSING' THEN 'SCHEDULED' ELSE "status"::text END)::"PayoutStatus_new"
);
ALTER TYPE "PayoutStatus" RENAME TO "PayoutStatus_old";
ALTER TYPE "PayoutStatus_new" RENAME TO "PayoutStatus";
DROP TYPE "public"."PayoutStatus_old";
ALTER TABLE "LandlordPayout" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "RepaymentStatus_new" AS ENUM ('SUCCEEDED', 'FAILED', 'RETURNED');
ALTER TABLE "Repayment" ALTER COLUMN "status" TYPE "RepaymentStatus_new" USING (
    (CASE WHEN "status"::text = 'PENDING' THEN 'FAILED' ELSE "status"::text END)::"RepaymentStatus_new"
);
ALTER TYPE "RepaymentStatus" RENAME TO "RepaymentStatus_old";
ALTER TYPE "RepaymentStatus_new" RENAME TO "RepaymentStatus";
DROP TYPE "public"."RepaymentStatus_old";
COMMIT;

-- AlterTable
ALTER TABLE "Installment" ADD COLUMN     "attemptBankLinkId" TEXT,
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chargedOffAt" TIMESTAMP(3),
ADD COLUMN     "collectionSkipReason" TEXT,
ADD COLUMN     "collectionSkippedOn" TEXT,
ADD COLUMN     "lastAttemptOn" TEXT;

-- AlterTable
ALTER TABLE "LandlordPayout" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "heldReason" TEXT,
ADD COLUMN     "returnCode" TEXT;

-- AlterTable
-- The effective date of a ledger transaction: the calendar date the movement belongs to,
-- as opposed to "postedAt", when the row was written. Existing rows take the date they were
-- posted. LedgerTransaction is append-only, so the guard is lifted for this one backfill
-- and put straight back.
ALTER TABLE "LedgerTransaction" ADD COLUMN     "effectiveDate" TEXT;
ALTER TABLE "LedgerTransaction" DISABLE TRIGGER "LedgerTransaction_append_only";
UPDATE "LedgerTransaction" SET "effectiveDate" = to_char("postedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD');
ALTER TABLE "LedgerTransaction" ENABLE TRIGGER "LedgerTransaction_append_only";
ALTER TABLE "LedgerTransaction" ALTER COLUMN "effectiveDate" SET NOT NULL;

-- AlterTable
ALTER TABLE "RentPlan" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedReason" TEXT,
ADD COLUMN     "delinquencyStatus" "DelinquencyStatus" NOT NULL DEFAULT 'CURRENT';

-- AlterTable
ALTER TABLE "Repayment" ADD COLUMN     "bankLinkId" TEXT,
ADD COLUMN     "manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recovery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "returnCode" TEXT,
ADD COLUMN     "returnedAt" TIMESTAMP(3);

-- The attempt counter starts from the failed attempts already on record.
UPDATE "Installment" i SET
    "attemptCount" = r.n,
    "lastAttemptOn" = r.last
FROM (
    SELECT "installmentId", COUNT(*)::int AS n, to_char(MAX("createdAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last
    FROM "Repayment" WHERE "status" = 'FAILED' GROUP BY "installmentId"
) r
WHERE r."installmentId" = i."id" AND i."status" <> 'PAID';

-- CreateIndex
CREATE INDEX "LandlordPayout_providerRef_idx" ON "LandlordPayout"("providerRef");

-- CreateIndex
CREATE INDEX "LedgerTransaction_effectiveDate_idx" ON "LedgerTransaction"("effectiveDate");

-- CreateIndex
CREATE INDEX "RentPlan_delinquencyStatus_idx" ON "RentPlan"("delinquencyStatus");

-- CreateIndex
CREATE INDEX "Repayment_providerRef_idx" ON "Repayment"("providerRef");
