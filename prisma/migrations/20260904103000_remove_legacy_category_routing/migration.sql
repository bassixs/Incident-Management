-- Category is now only the topic selected by the requester. Operational
-- routing belongs exclusively to ResponsibleGroup.
ALTER TABLE "Incident" DROP CONSTRAINT "Incident_assignedCategoryId_fkey";
DROP INDEX "Incident_assignedCategoryId_idx";
ALTER TABLE "Incident" DROP COLUMN "assignedCategoryId";

ALTER TABLE "Category"
    DROP COLUMN "maxChatId",
    DROP COLUMN "authorityName",
    DROP COLUMN "answerTemplate";
