BEGIN;
CREATE SEQUENCE "OutboundMessage_sequence_seq";
ALTER TABLE "OutboundMessage" ADD COLUMN "sequence" BIGINT;
WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS n FROM "OutboundMessage"
)
UPDATE "OutboundMessage" AS m SET "sequence" = ordered.n FROM ordered WHERE m."id" = ordered."id";
SELECT setval('"OutboundMessage_sequence_seq"', COALESCE(MAX("sequence"), 0) + 1, false) FROM "OutboundMessage";
ALTER TABLE "OutboundMessage" ALTER COLUMN "sequence" SET DEFAULT nextval('"OutboundMessage_sequence_seq"');
ALTER TABLE "OutboundMessage" ALTER COLUMN "sequence" SET NOT NULL;
ALTER SEQUENCE "OutboundMessage_sequence_seq" OWNED BY "OutboundMessage"."sequence";
CREATE UNIQUE INDEX "OutboundMessage_sequence_key" ON "OutboundMessage"("sequence");
CREATE INDEX "OutboundMessage_targetType_targetId_status_sequence_idx" ON "OutboundMessage"("targetType", "targetId", "status", "sequence");
COMMIT;
