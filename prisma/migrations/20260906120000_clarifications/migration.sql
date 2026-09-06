CREATE TYPE "ClarificationStatus" AS ENUM ('DRAFT', 'PENDING_DELIVERY', 'WAITING_REPLY', 'ANSWERED', 'CANCELLED');
ALTER TYPE "SessionType" ADD VALUE 'WAITING_CLARIFICATION_QUESTION';
ALTER TYPE "SessionType" ADD VALUE 'WAITING_CLARIFICATION_REPLY';
ALTER TABLE "Incident" ADD COLUMN "activeClarificationId" TEXT, ADD COLUMN "slaPausedAt" TIMESTAMP(3), ADD COLUMN "slaPausedMs" BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Incident_activeClarificationId_key" ON "Incident"("activeClarificationId");
CREATE TABLE "Clarification" (
 "id" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "status" "ClarificationStatus" NOT NULL DEFAULT 'DRAFT',
 "question" TEXT NOT NULL, "askedByUserId" TEXT NOT NULL, "askedByMaxUserId" BIGINT NOT NULL, "chatId" BIGINT NOT NULL,
 "questionSourceId" TEXT NOT NULL, "replySourceId" TEXT, "replyText" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deliveredAt" TIMESTAMP(3), "answeredAt" TIMESTAMP(3),
 CONSTRAINT "Clarification_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Clarification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Clarification_questionSourceId_key" ON "Clarification"("questionSourceId");
CREATE INDEX "Clarification_incidentId_createdAt_idx" ON "Clarification"("incidentId", "createdAt");
CREATE TABLE "ClarificationAttachment" (
 "id" TEXT NOT NULL, "clarificationId" TEXT NOT NULL, "type" "AttachmentType" NOT NULL,
 "storageKey" TEXT NOT NULL, "originalName" TEXT, "size" INTEGER,
 CONSTRAINT "ClarificationAttachment_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ClarificationAttachment_clarificationId_fkey" FOREIGN KEY ("clarificationId") REFERENCES "Clarification"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ClarificationAttachment_clarificationId_idx" ON "ClarificationAttachment"("clarificationId");
