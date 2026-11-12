-- A pass-through eligibility review is history beside the origination decision, like a
-- periodic review: it is never the current decision. Separate from the migration that added
-- the enum value, because Postgres does not allow a new enum value to be used in the
-- transaction that added it.
DROP INDEX "UnderwritingDecision_current_key";

CREATE UNIQUE INDEX "UnderwritingDecision_current_key" ON "UnderwritingDecision"("applicationId")
    WHERE "supersededAt" IS NULL AND "kind" NOT IN ('PERIODIC_REVIEW', 'ELIGIBILITY_REVIEW');
