-- Credit policy v2: append-only decisions with policy version and snapshot, manual review,
-- audit log, the re-underwriting freeze, and append-only guards on audit and ledger rows.

-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'IN_REVIEW';

-- AlterEnum
ALTER TYPE "DecisionOutcome" ADD VALUE 'REFER';

-- CreateEnum
CREATE TYPE "DecisionKind" AS ENUM ('ENGINE', 'REVIEW', 'PERIODIC_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'DECLINE', 'REQUEST_INFO');

-- Decisions become append-only: one application, many decisions, one current.
DROP INDEX "UnderwritingDecision_applicationId_key";

-- AlterTable
ALTER TABLE "UnderwritingDecision"
    ADD COLUMN "kind" "DecisionKind" NOT NULL DEFAULT 'ENGINE',
    ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT 'cashflow-v1',
    ADD COLUMN "snapshot" JSONB,
    ADD COLUMN "supersededAt" TIMESTAMP(3),
    ADD COLUMN "reviewId" TEXT,
    ADD COLUMN "isOverride" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reviewPeriod" TEXT;

-- AlterTable
ALTER TABLE "RentPlan"
    ADD COLUMN "advanceFrozenAt" TIMESTAMP(3),
    ADD COLUMN "advanceFrozenReason" TEXT;

-- CreateTable
CREATE TABLE "ApplicationReview" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "reasonCodes" TEXT[],
    "notes" TEXT,
    "approvedMonthlyLimitCents" INTEGER,
    "feeBps" INTEGER,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "reviewedDecisionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnderwritingDecision_applicationId_reviewPeriod_key" ON "UnderwritingDecision"("applicationId", "reviewPeriod");

-- CreateIndex
CREATE INDEX "UnderwritingDecision_applicationId_supersededAt_idx" ON "UnderwritingDecision"("applicationId", "supersededAt");

-- At most one current origination decision per application. Periodic reviews are a history
-- beside it and are keyed by month above. Prisma cannot express a partial index, so it lives
-- only here.
CREATE UNIQUE INDEX "UnderwritingDecision_current_key" ON "UnderwritingDecision"("applicationId")
    WHERE "supersededAt" IS NULL AND "kind" <> 'PERIODIC_REVIEW';

-- CreateIndex
CREATE INDEX "ApplicationReview_applicationId_idx" ON "ApplicationReview"("applicationId");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectType_subjectId_idx" ON "AuditEvent"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_at_idx" ON "AuditEvent"("eventType", "at");

-- AddForeignKey
ALTER TABLE "UnderwritingDecision" ADD CONSTRAINT "UnderwritingDecision_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ApplicationReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationReview" ADD CONSTRAINT "ApplicationReview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "UnderwritingApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only guards. Audit events and ledger rows are history: a correction is a new row,
-- never an edit. Row triggers do not fire on TRUNCATE, which the seed and the test helpers
-- use to start from an empty database.
CREATE FUNCTION cashflow_reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_append_only"
    BEFORE UPDATE OR DELETE ON "AuditEvent"
    FOR EACH ROW EXECUTE FUNCTION cashflow_reject_mutation();

CREATE TRIGGER "LedgerEntry_append_only"
    BEFORE UPDATE OR DELETE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION cashflow_reject_mutation();

CREATE TRIGGER "LedgerTransaction_append_only"
    BEFORE UPDATE OR DELETE ON "LedgerTransaction"
    FOR EACH ROW EXECUTE FUNCTION cashflow_reject_mutation();
