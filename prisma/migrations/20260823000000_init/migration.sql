-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('NEW', 'DISTRIBUTION', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_REVIEW', 'REVISION_REQUIRED', 'REJECTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AnswerStatus" AS ENUM ('DRAFT', 'WAITING_REVIEW', 'APPROVED', 'REVISION_REQUIRED');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'FILE');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('WAITING_INCIDENT_TEXT', 'WAITING_REJECTION_REASON', 'WAITING_REVISION_REASON', 'WAITING_FOR_ANSWER', 'WAITING_BAN_REASON');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('REQUESTER', 'DISPATCHER', 'RESPONDER', 'APPROVER', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "maxUserId" BIGINT NOT NULL,
    "displayName" TEXT NOT NULL,
    "username" TEXT,
    "roles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxChatId" BIGINT,
    "answerTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "publicCode" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterMaxUserId" BIGINT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "userSelectedCategoryId" TEXT,
    "aiSuggestedCategoryId" TEXT,
    "assignedCategoryId" TEXT,
    "aiSuggestions" JSONB,
    "aiPossibleAbuse" BOOLEAN NOT NULL DEFAULT false,
    "aiPossibleOfftopic" BOOLEAN NOT NULL DEFAULT false,
    "aiModerationReason" TEXT,
    "status" "IncidentStatus" NOT NULL DEFAULT 'DISTRIBUTION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "distributionMessageId" TEXT,
    "sectorMessageId" TEXT,
    "reviewMessageId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "assignedByUserId" TEXT,
    "currentResponderId" TEXT,
    "approvedByUserId" TEXT,
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "revisionReason" TEXT,
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "slaWarn24SentAt" TIMESTAMP(3),
    "slaWarn6SentAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAttachment" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "originalName" TEXT,
    "size" INTEGER,
    "sourceUrl" TEXT,
    "maxToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAnswer" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "AnswerStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "revisionReason" TEXT,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "IncidentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerAttachment" (
    "id" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "originalName" TEXT,
    "size" INTEGER,
    "sourceUrl" TEXT,
    "maxToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentHistory" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" "IncidentStatus",
    "toStatus" "IncidentStatus",
    "actorMaxUserId" BIGINT,
    "actorRole" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ban" (
    "id" TEXT NOT NULL,
    "maxUserId" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ban_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorSession" (
    "id" TEXT NOT NULL,
    "maxUserId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "type" "SessionType" NOT NULL,
    "incidentId" TEXT,
    "data" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "IncidentCounter" (
    "day" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IncidentCounter_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "ProcessedUpdate" (
    "id" TEXT NOT NULL,
    "externalUpdateKey" TEXT NOT NULL,
    "updateType" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_maxUserId_key" ON "User"("maxUserId");

-- CreateIndex
CREATE INDEX "User_maxUserId_idx" ON "User"("maxUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");

-- CreateIndex
CREATE INDEX "Category_isActive_sortOrder_idx" ON "Category"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_publicCode_key" ON "Incident"("publicCode");

-- CreateIndex
CREATE INDEX "Incident_requesterId_createdAt_idx" ON "Incident"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_requesterMaxUserId_createdAt_idx" ON "Incident"("requesterMaxUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- CreateIndex
CREATE INDEX "Incident_deadlineAt_idx" ON "Incident"("deadlineAt");

-- CreateIndex
CREATE INDEX "Incident_assignedCategoryId_idx" ON "Incident"("assignedCategoryId");

-- CreateIndex
CREATE INDEX "Incident_createdAt_idx" ON "Incident"("createdAt");

-- CreateIndex
CREATE INDEX "IncidentAttachment_incidentId_idx" ON "IncidentAttachment"("incidentId");

-- CreateIndex
CREATE INDEX "IncidentAnswer_incidentId_status_idx" ON "IncidentAnswer"("incidentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAnswer_incidentId_version_key" ON "IncidentAnswer"("incidentId", "version");

-- CreateIndex
CREATE INDEX "AnswerAttachment_answerId_idx" ON "AnswerAttachment"("answerId");

-- CreateIndex
CREATE INDEX "IncidentHistory_incidentId_createdAt_idx" ON "IncidentHistory"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentHistory_action_idx" ON "IncidentHistory"("action");

-- CreateIndex
CREATE INDEX "Ban_maxUserId_isActive_idx" ON "Ban"("maxUserId", "isActive");

-- CreateIndex
CREATE INDEX "OperatorSession_maxUserId_chatId_idx" ON "OperatorSession"("maxUserId", "chatId");

-- CreateIndex
CREATE INDEX "OperatorSession_expiresAt_idx" ON "OperatorSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSession_maxUserId_chatId_key" ON "OperatorSession"("maxUserId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedUpdate_externalUpdateKey_key" ON "ProcessedUpdate"("externalUpdateKey");

-- CreateIndex
CREATE INDEX "ProcessedUpdate_processedAt_idx" ON "ProcessedUpdate"("processedAt");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_userSelectedCategoryId_fkey" FOREIGN KEY ("userSelectedCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_aiSuggestedCategoryId_fkey" FOREIGN KEY ("aiSuggestedCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assignedCategoryId_fkey" FOREIGN KEY ("assignedCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_currentResponderId_fkey" FOREIGN KEY ("currentResponderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAttachment" ADD CONSTRAINT "IncidentAttachment_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAnswer" ADD CONSTRAINT "IncidentAnswer_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAnswer" ADD CONSTRAINT "IncidentAnswer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAnswer" ADD CONSTRAINT "IncidentAnswer_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerAttachment" ADD CONSTRAINT "AnswerAttachment_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "IncidentAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentHistory" ADD CONSTRAINT "IncidentHistory_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ban" ADD CONSTRAINT "Ban_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

