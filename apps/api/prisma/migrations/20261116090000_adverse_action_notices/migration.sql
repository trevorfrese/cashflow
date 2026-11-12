-- Adverse action notices, and the principal reasons stored on each decision.
--
-- A notice is stored exactly as it was delivered, with the reasons rendered into it, and is
-- never edited or removed. Like DataSnapshot the table has no foreign keys, so deleting a
-- business or an application never has to delete a notice it was sent: Regulation B asks
-- for these records to be kept (12 CFR 1002.12(b)). One notice per decision and kind keeps
-- the notices job idempotent.

-- CreateEnum
CREATE TYPE "AdverseActionNoticeKind" AS ENUM ('DECLINE', 'COUNTER_OFFER_NOT_ACCEPTED', 'INCOMPLETE', 'INCOMPLETE_DECLINED');

-- CreateEnum
CREATE TYPE "NoticeChannel" AS ENUM ('IN_APP');

-- AlterTable
ALTER TABLE "UnderwritingDecision" ADD COLUMN "principalReasons" JSONB;

-- CreateTable
CREATE TABLE "AdverseActionNotice" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "AdverseActionNoticeKind" NOT NULL,
    "principalReasons" JSONB NOT NULL,
    "reasonCodes" TEXT[],
    "text" TEXT NOT NULL,
    "statementVersion" TEXT NOT NULL,
    "actionOn" TEXT NOT NULL,
    "deadlineOn" TEXT NOT NULL,
    "respondBy" TEXT,
    "channel" "NoticeChannel" NOT NULL DEFAULT 'IN_APP',
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "generatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdverseActionNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdverseActionNotice_decisionId_kind_key" ON "AdverseActionNotice"("decisionId", "kind");

-- CreateIndex
CREATE INDEX "AdverseActionNotice_applicationId_idx" ON "AdverseActionNotice"("applicationId");

-- CreateIndex
CREATE INDEX "AdverseActionNotice_businessId_idx" ON "AdverseActionNotice"("businessId");

-- A notice is a record of what an applicant was told: nothing may rewrite or remove one.
CREATE TRIGGER "AdverseActionNotice_append_only"
    BEFORE UPDATE OR DELETE ON "AdverseActionNotice"
    FOR EACH ROW EXECUTE FUNCTION cashflow_reject_mutation();
