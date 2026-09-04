CREATE TYPE "LegalAcceptanceType" AS ENUM ('USER_AGREEMENT', 'PERSONAL_DATA_CONSENT');

CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxUserId" BIGINT NOT NULL,
    "type" "LegalAcceptanceType" NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "confirmationText" TEXT NOT NULL,
    "sourceCallbackId" TEXT,
    "sourceMessageId" TEXT,
    "sourceChatId" BIGINT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalAcceptance_sourceCallbackId_key" ON "LegalAcceptance"("sourceCallbackId");
CREATE UNIQUE INDEX "LegalAcceptance_userId_type_documentVersion_key" ON "LegalAcceptance"("userId", "type", "documentVersion");
CREATE INDEX "LegalAcceptance_maxUserId_acceptedAt_idx" ON "LegalAcceptance"("maxUserId", "acceptedAt");
CREATE INDEX "LegalAcceptance_type_documentVersion_idx" ON "LegalAcceptance"("type", "documentVersion");

ALTER TABLE "LegalAcceptance"
ADD CONSTRAINT "LegalAcceptance_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
