ALTER TABLE "InboundUpdate" ADD COLUMN "partitionKey" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "InboundUpdate" ADD COLUMN "sequence" BIGSERIAL NOT NULL;
UPDATE "InboundUpdate" SET "partitionKey" = 'user:' || COALESCE(
  payload #>> '{callback,user,user_id}', payload #>> '{message,sender,user_id}', payload #>> '{user,user_id}')
WHERE COALESCE(payload #>> '{callback,user,user_id}', payload #>> '{message,sender,user_id}', payload #>> '{user,user_id}') ~ '^[0-9]+$';
CREATE UNIQUE INDEX "InboundUpdate_sequence_key" ON "InboundUpdate"("sequence");
CREATE INDEX "InboundUpdate_status_partitionKey_sequence_idx" ON "InboundUpdate"("status", "partitionKey", "sequence");
