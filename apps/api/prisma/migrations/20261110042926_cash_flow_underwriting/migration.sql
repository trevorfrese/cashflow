-- AlterTable
ALTER TABLE "UnderwritingDecision" ADD COLUMN     "cashFlow" JSONB,
ADD COLUMN     "grade" TEXT,
ADD COLUMN     "recommendedInstallmentsPerMonth" INTEGER,
ADD COLUMN     "score" INTEGER;
