CREATE TABLE "PrivateWorkItem" (
  "id" TEXT NOT NULL,
  "maxUserId" BIGINT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "originChatId" BIGINT NOT NULL,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "openedAt" TIMESTAMP(3),
  "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivateWorkItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivateWorkItem_maxUserId_fkey" FOREIGN KEY ("maxUserId") REFERENCES "User"("maxUserId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PrivateWorkItem_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PrivateWorkItem_maxUserId_incidentId_originChatId_key" ON "PrivateWorkItem"("maxUserId", "incidentId", "originChatId");
CREATE INDEX "PrivateWorkItem_maxUserId_selected_idx" ON "PrivateWorkItem"("maxUserId", "selected");
CREATE INDEX "PrivateWorkItem_incidentId_idx" ON "PrivateWorkItem"("incidentId");
