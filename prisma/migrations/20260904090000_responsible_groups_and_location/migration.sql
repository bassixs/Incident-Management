-- The requester-facing topic and the operational destination are independent.
CREATE TYPE "ResponsibleGroupKind" AS ENUM ('REGIONAL', 'LOCAL_GOVERNMENT', 'EXECUTIVE_AUTHORITY');

ALTER TYPE "SessionType" ADD VALUE 'WAITING_CUSTOM_LOCALITY';

CREATE TABLE "ResponsibleGroup" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ResponsibleGroupKind" NOT NULL,
    "maxChatId" BIGINT,
    "municipalityCode" TEXT,
    "authorityName" TEXT,
    "answerTemplate" TEXT,
    "bypassReview" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResponsibleGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Incident"
    ADD COLUMN "assignedGroupId" TEXT,
    ADD COLUMN "problemMunicipalityCode" TEXT,
    ADD COLUMN "problemMunicipalityName" TEXT,
    ADD COLUMN "problemLocality" TEXT;

CREATE UNIQUE INDEX "ResponsibleGroup_code_key" ON "ResponsibleGroup"("code");
CREATE UNIQUE INDEX "ResponsibleGroup_maxChatId_key" ON "ResponsibleGroup"("maxChatId");
CREATE UNIQUE INDEX "ResponsibleGroup_municipalityCode_key" ON "ResponsibleGroup"("municipalityCode");
CREATE INDEX "ResponsibleGroup_kind_isActive_sortOrder_idx" ON "ResponsibleGroup"("kind", "isActive", "sortOrder");
CREATE INDEX "Incident_assignedGroupId_idx" ON "Incident"("assignedGroupId");
CREATE INDEX "Incident_problemMunicipalityCode_idx" ON "Incident"("problemMunicipalityCode");

ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assignedGroupId_fkey"
    FOREIGN KEY ("assignedGroupId") REFERENCES "ResponsibleGroup"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
