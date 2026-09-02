ALTER TABLE "InboundUpdate"
ADD COLUMN "deliveryAlertedAt" TIMESTAMP(3);

ALTER TABLE "OutboundMessage"
ADD COLUMN "deliveryAlertedAt" TIMESTAMP(3);

CREATE INDEX "InboundUpdate_status_deliveryAlertedAt_idx"
ON "InboundUpdate"("status", "deliveryAlertedAt");

CREATE INDEX "OutboundMessage_status_deliveryAlertedAt_idx"
ON "OutboundMessage"("status", "deliveryAlertedAt");
