ALTER TABLE "User"
  ADD COLUMN "requesterName" TEXT,
  ADD COLUMN "requesterPhone" TEXT;

-- Existing users should not have to repeat details they already confirmed.
UPDATE "User" AS target
SET
  "requesterName" = latest."requesterName",
  "requesterPhone" = latest."requesterPhone"
FROM (
  SELECT DISTINCT ON ("requesterId")
    "requesterId",
    "requesterName",
    "requesterPhone"
  FROM "Incident"
  WHERE "requesterPhone" IS NOT NULL
  ORDER BY "requesterId", "createdAt" DESC
) AS latest
WHERE target."id" = latest."requesterId";
