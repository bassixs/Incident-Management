-- These dispositions belong to working-deadline notifications only.
-- No existing jobs, acknowledgements or retry counters are rewritten.
ALTER TYPE "OutboxStatus" ADD VALUE 'DEFERRED';
ALTER TYPE "OutboxStatus" ADD VALUE 'CANCELLED';
ALTER TABLE "OutboundMessage" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
