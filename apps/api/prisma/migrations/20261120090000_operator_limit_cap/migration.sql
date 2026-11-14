-- An admin can lower the monthly rent a business may have fronted below what its decision
-- approved, from the operations console. Tighten only: the effective limit is the smaller of
-- the decision's limit and this cap. Null means no cap.
ALTER TABLE "Business" ADD COLUMN "limitCapCents" INTEGER;
ALTER TABLE "Business" ADD COLUMN "limitCapSetAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN "limitCapSetBy" TEXT;
ALTER TABLE "Business" ADD COLUMN "limitCapReason" TEXT;

ALTER TABLE "Business" ADD CONSTRAINT "Business_limitCapCents_nonnegative"
  CHECK ("limitCapCents" IS NULL OR "limitCapCents" >= 0);
