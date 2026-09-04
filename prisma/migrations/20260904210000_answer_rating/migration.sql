ALTER TABLE "Incident"
  ADD COLUMN "responseRating" INTEGER,
  ADD COLUMN "ratedAt" TIMESTAMP(3);

ALTER TABLE "Incident"
  ADD CONSTRAINT "Incident_responseRating_check"
  CHECK ("responseRating" IS NULL OR "responseRating" BETWEEN 1 AND 5);

CREATE INDEX "Incident_responseRating_idx" ON "Incident"("responseRating");
