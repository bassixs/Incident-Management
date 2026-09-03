-- Retention sweeps select only terminal incidents by their completion date.
-- The composite index keeps that daily query bounded as the table grows.
CREATE INDEX "Incident_status_answeredAt_idx" ON "Incident"("status", "answeredAt");
