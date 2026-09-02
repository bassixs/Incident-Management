CREATE TYPE "InboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');
CREATE TYPE "DeliveryTrackingType" AS ENUM ('DISTRIBUTION_CARD', 'SECTOR_CARD', 'REVIEW_CARD', 'ANSWER_TO_REQUESTER');

CREATE TABLE "InboundUpdate" (
    "id" TEXT NOT NULL,
    "externalUpdateKey" TEXT NOT NULL,
    "updateType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundUpdate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "firstMessageId" TEXT,
    "trackingType" "DeliveryTrackingType",
    "incidentId" TEXT,
    "answerId" TEXT,
    "trackingApplied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActionLock" (
    "key" TEXT NOT NULL,
    "maxUserId" BIGINT NOT NULL,
    "incidentId" TEXT,
    "action" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ActionLock_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "InboundUpdate_externalUpdateKey_key" ON "InboundUpdate"("externalUpdateKey");
CREATE INDEX "InboundUpdate_status_nextAttemptAt_idx" ON "InboundUpdate"("status", "nextAttemptAt");
CREATE INDEX "InboundUpdate_lockedAt_idx" ON "InboundUpdate"("lockedAt");
CREATE INDEX "InboundUpdate_receivedAt_idx" ON "InboundUpdate"("receivedAt");

CREATE UNIQUE INDEX "OutboundMessage_dedupeKey_key" ON "OutboundMessage"("dedupeKey");
CREATE INDEX "OutboundMessage_status_nextAttemptAt_idx" ON "OutboundMessage"("status", "nextAttemptAt");
CREATE INDEX "OutboundMessage_lockedAt_idx" ON "OutboundMessage"("lockedAt");
CREATE INDEX "OutboundMessage_incidentId_idx" ON "OutboundMessage"("incidentId");
CREATE INDEX "OutboundMessage_createdAt_idx" ON "OutboundMessage"("createdAt");

CREATE INDEX "ActionLock_lockedUntil_idx" ON "ActionLock"("lockedUntil");
CREATE INDEX "ActionLock_maxUserId_idx" ON "ActionLock"("maxUserId");
CREATE INDEX "ActionLock_incidentId_idx" ON "ActionLock"("incidentId");
