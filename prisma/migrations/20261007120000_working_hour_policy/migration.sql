ALTER TABLE "Incident" ADD COLUMN "slaPolicy" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "slaDeliveredAt" TIMESTAMP(3), ADD COLUMN "workingDeadlineQueuedAt" TIMESTAMP(3);
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_slaPolicy_check" CHECK ("slaPolicy" IN ('LEGACY', 'WORKING_HOURS_V1'));
CREATE TABLE "IncidentAssignmentCycle" (
  "id" TEXT NOT NULL PRIMARY KEY, "incidentId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "groupId" TEXT NOT NULL, "groupCode" TEXT NOT NULL, "groupName" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL, "preparationDueAt" TIMESTAMP(3) NOT NULL, "returnDueAt" TIMESTAMP(3) NOT NULL,
  "cardDeliveredAt" TIMESTAMP(3), "firstPreparedAt" TIMESTAMP(3), "firstPreparedAnswerId" TEXT,
  "returnedAt" TIMESTAMP(3), "returnReason" TEXT, "endedAt" TIMESTAMP(3), "outcome" TEXT NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "IncidentAssignmentCycle_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IncidentAssignmentCycle_incidentId_sequence_key" ON "IncidentAssignmentCycle"("incidentId", "sequence");
CREATE INDEX "IncidentAssignmentCycle_incidentId_endedAt_idx" ON "IncidentAssignmentCycle"("incidentId", "endedAt");
CREATE UNIQUE INDEX "IncidentAssignmentCycle_one_active" ON "IncidentAssignmentCycle"("incidentId") WHERE "endedAt" IS NULL;
