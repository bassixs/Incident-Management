ALTER TABLE "Incident" ADD COLUMN "distributionClaimedBy" BIGINT,
 ADD COLUMN "distributionClaimedName" TEXT,
 ADD COLUMN "distributionClaimUntil" TIMESTAMP(3);
CREATE INDEX "Incident_status_createdAt_id_idx" ON "Incident"("status", "createdAt", "id");
CREATE INDEX "Incident_distributionClaimedBy_distributionClaimUntil_idx" ON "Incident"("distributionClaimedBy", "distributionClaimUntil");
