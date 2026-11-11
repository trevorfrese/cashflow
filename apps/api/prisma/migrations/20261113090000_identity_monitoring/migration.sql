-- Phase R4: identity verification and sanctions screening, lease change control, the
-- monitoring engine (alerts and the circuit breaker), and login lockout.
--
-- Existing rows migrate without a backfill: a business keeps a null tax id and no owners
-- and is UNVERIFIED, which sends its next application to a reviewer instead of approving it.

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "ScreeningOutcome" AS ENUM ('CLEAR', 'POSSIBLE_MATCH', 'MATCH');

-- CreateEnum
CREATE TYPE "ScreeningPartyType" AS ENUM ('BUSINESS', 'OWNER', 'LANDLORD');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "LeaseChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'CANCELLED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFailedLoginAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "taxIdLast4" TEXT,
ADD COLUMN     "verificationCheckedAt" TIMESTAMP(3),
ADD COLUMN     "verificationProvider" TEXT,
ADD COLUMN     "verificationReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verificationRef" TEXT,
ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';

-- AlterTable
ALTER TABLE "RentPlan" ADD COLUMN     "pendingRentCents" INTEGER,
ADD COLUMN     "pendingRentSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LandlordPayout" ADD COLUMN     "resendCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BeneficialOwner" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownershipBps" INTEGER NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verificationRef" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BeneficialOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningResult" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "partyType" "ScreeningPartyType" NOT NULL,
    "partyRef" TEXT NOT NULL,
    "nameScreened" TEXT NOT NULL,
    "country" TEXT,
    "result" "ScreeningOutcome" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "leaseChangeId" TEXT,
    "screenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "clearedBy" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedReason" TEXT,

    CONSTRAINT "ScreeningResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "disposition" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircuitBreaker" (
    "id" TEXT NOT NULL,
    "tripped" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "trippedAt" TIMESTAMP(3),
    "trippedByRule" TEXT,
    "trippedAlertId" TEXT,
    "resetAt" TIMESTAMP(3),
    "resetBy" TEXT,
    "resetReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitBreaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseChange" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "LeaseChangeStatus" NOT NULL DEFAULT 'PENDING',
    "changes" JSONB NOT NULL,
    "previous" JSONB NOT NULL,
    "fields" TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveOn" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "LeaseChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BeneficialOwner_businessId_idx" ON "BeneficialOwner"("businessId");

-- CreateIndex
CREATE INDEX "ScreeningResult_partyType_partyRef_supersededAt_idx" ON "ScreeningResult"("partyType", "partyRef", "supersededAt");

-- CreateIndex
CREATE INDEX "ScreeningResult_businessId_idx" ON "ScreeningResult"("businessId");

-- CreateIndex
CREATE INDEX "ScreeningResult_result_clearedAt_idx" ON "ScreeningResult"("result", "clearedAt");

-- CreateIndex
CREATE INDEX "Alert_status_severity_idx" ON "Alert"("status", "severity");

-- CreateIndex
CREATE INDEX "Alert_type_idx" ON "Alert"("type");

-- CreateIndex
CREATE INDEX "Alert_subjectType_subjectId_idx" ON "Alert"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Alert_dedupeKey_idx" ON "Alert"("dedupeKey");

-- CreateIndex
CREATE INDEX "LeaseChange_leaseId_status_idx" ON "LeaseChange"("leaseId", "status");

-- CreateIndex
CREATE INDEX "LeaseChange_status_effectiveOn_idx" ON "LeaseChange"("status", "effectiveOn");

-- AddForeignKey
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningResult" ADD CONSTRAINT "ScreeningResult_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseChange" ADD CONSTRAINT "LeaseChange_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique indexes. Prisma cannot express them, so they live only here.
-- One alert per condition while it is open: a resolved alert does not block a new one.
CREATE UNIQUE INDEX "Alert_open_dedupe_key" ON "Alert"("dedupeKey") WHERE "status" <> 'RESOLVED';

-- One pending change per lease.
CREATE UNIQUE INDEX "LeaseChange_pending_key" ON "LeaseChange"("leaseId") WHERE "status" = 'PENDING';
