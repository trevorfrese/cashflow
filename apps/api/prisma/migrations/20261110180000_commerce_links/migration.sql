-- CreateEnum
CREATE TYPE "CommercePlatform" AS ENUM ('SQUARE', 'TOAST', 'SHOPIFY', 'CLOVER', 'STRIPE');

-- CreateTable
CREATE TABLE "CommerceLink" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "platform" "CommercePlatform" NOT NULL,
    "providerItemId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "status" "BankLinkStatus" NOT NULL DEFAULT 'LINKED',
    "connectedSince" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceLink_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "UnderwritingApplication" ADD COLUMN     "commerceLinkId" TEXT;

-- CreateIndex
CREATE INDEX "CommerceLink_businessId_idx" ON "CommerceLink"("businessId");

-- AddForeignKey
ALTER TABLE "CommerceLink" ADD CONSTRAINT "CommerceLink_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnderwritingApplication" ADD CONSTRAINT "UnderwritingApplication_commerceLinkId_fkey" FOREIGN KEY ("commerceLinkId") REFERENCES "CommerceLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
