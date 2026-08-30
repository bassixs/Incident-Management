-- Manual report ranges are typed in after pressing a button, which needs its
-- own pending-action type. Additive only: existing sessions are unaffected.
ALTER TYPE "SessionType" ADD VALUE IF NOT EXISTS 'WAITING_REPORT_PERIOD';
