-- Data veracity: provenance on every data connection, OAuth authorizations in flight, and
-- append-only snapshots of every pull.
--
-- Existing links migrate with the method they always had (a bank through an aggregator, a
-- point of sale through a direct connection) and no stored token: the mock providers read
-- them by item id as before.

-- CreateEnum
CREATE TYPE "ConnectionAccessMethod" AS ENUM ('DIRECT_OAUTH', 'DELEGATED_SEAT', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "ConnectionHealth" AS ENUM ('HEALTHY', 'PENDING', 'REAUTH_REQUIRED', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConnectionKind" AS ENUM ('BANK', 'COMMERCE');

-- AlterTable
ALTER TABLE "BankLink" ADD COLUMN     "accessMethod" "ConnectionAccessMethod" NOT NULL DEFAULT 'AGGREGATOR',
ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "accountOpenedOn" TEXT,
ADD COLUMN     "accountOwnerNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "accountType" TEXT,
ADD COLUMN     "consentExpiresAt" TIMESTAMP(3),
ADD COLUMN     "consentScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "health" "ConnectionHealth" NOT NULL DEFAULT 'HEALTHY',
ADD COLUMN     "institutionAuthorized" BOOLEAN,
ADD COLUMN     "lastPullError" TEXT,
ADD COLUMN     "lastPulledAt" TIMESTAMP(3),
ADD COLUMN     "platformAccountId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "visibleAccounts" JSONB;

-- AlterTable
ALTER TABLE "CommerceLink" ADD COLUMN     "accessMethod" "ConnectionAccessMethod" NOT NULL DEFAULT 'DIRECT_OAUTH',
ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "accountCreatedOn" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "health" "ConnectionHealth" NOT NULL DEFAULT 'HEALTHY',
ADD COLUMN     "lastPullError" TEXT,
ADD COLUMN     "lastPulledAt" TIMESTAMP(3),
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "payoutDestinations" JSONB,
ADD COLUMN     "platformAccountId" TEXT,
ADD COLUMN     "refreshTokenEnc" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "seatServiceUser" TEXT,
ADD COLUMN     "seatVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "taxIdLast4" TEXT,
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConnectionAuthorization" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "CommercePlatform" NOT NULL,
    "provider" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeVerifierEnc" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "commerceLinkId" TEXT,

    CONSTRAINT "ConnectionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSnapshot" (
    "id" TEXT NOT NULL,
    "kind" "ConnectionKind" NOT NULL,
    "businessId" TEXT NOT NULL,
    "bankLinkId" TEXT,
    "commerceLinkId" TEXT,
    "provider" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "pulledAt" TIMESTAMP(3) NOT NULL,
    "windowFrom" TEXT NOT NULL,
    "windowTo" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "recordCounts" JSONB NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorization_state_key" ON "ConnectionAuthorization"("state");

-- CreateIndex
CREATE INDEX "ConnectionAuthorization_businessId_idx" ON "ConnectionAuthorization"("businessId");

-- CreateIndex
CREATE INDEX "DataSnapshot_bankLinkId_pulledAt_idx" ON "DataSnapshot"("bankLinkId", "pulledAt");

-- CreateIndex
CREATE INDEX "DataSnapshot_commerceLinkId_pulledAt_idx" ON "DataSnapshot"("commerceLinkId", "pulledAt");

-- CreateIndex
CREATE INDEX "DataSnapshot_businessId_idx" ON "DataSnapshot"("businessId");

-- A snapshot is evidence: nothing may rewrite or remove one. Same function as the audit table.
CREATE TRIGGER "DataSnapshot_append_only"
    BEFORE UPDATE OR DELETE ON "DataSnapshot"
    FOR EACH ROW EXECUTE FUNCTION cashflow_reject_mutation();
