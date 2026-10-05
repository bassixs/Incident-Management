-- Read-only evidence, NOT an authorization to start an older application.
-- Run after all application/inbox/outbox workers have stopped gracefully.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
-- BEGIN PREVIEW QUERY
WITH progress AS (
  SELECT id, status, "trackingApplied", "lockedAt", attempts,
         payload ? 'deliveryProgress' AS has_progress,
         payload->'deliveryProgress' AS p
  FROM "OutboundMessage"
), measured AS (
  SELECT *, CASE WHEN jsonb_typeof(p->'mids') = 'array'
                 THEN jsonb_array_length(p->'mids') END AS confirmed_parts,
         CASE WHEN jsonb_typeof(p->'totalParts') = 'number'
                   AND p->>'totalParts' ~ '^[1-9][0-9]*$'
              THEN (p->>'totalParts')::numeric END AS total_parts
  FROM progress
), classified AS (
  SELECT id, status, attempts, "lockedAt", confirmed_parts, total_parts,
    CASE
      WHEN NOT has_progress THEN CASE WHEN status = 'SENT' THEN 'LEGACY_COMPLETED' ELSE 'NO_PROGRESS_REQUIRES_REVIEW' END
      WHEN jsonb_typeof(p) IS DISTINCT FROM 'object'
        OR p->'version' IS DISTINCT FROM '1'::jsonb
        OR confirmed_parts IS NULL OR total_parts IS NULL OR confirmed_parts > total_parts
        OR coalesce(p->>'planHash', '') !~ '^[a-f0-9]{64}$'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'mids') = 'array' THEN p->'mids' ELSE '[]'::jsonb END) mid
                   WHERE jsonb_typeof(mid) <> 'string' OR mid = '""'::jsonb)
        THEN 'BLOCK_INVALID_PROGRESS'
      WHEN status = 'SENT' THEN CASE WHEN confirmed_parts = total_parts AND "trackingApplied"
                                    THEN 'COMPLETED_PROGRESS' ELSE 'BLOCK_INCONSISTENT_SENT' END
      WHEN confirmed_parts = total_parts THEN 'BLOCK_ALL_ACKED_NOT_COMPLETED'
      WHEN confirmed_parts > 0 AND status = 'FAILED' THEN 'BLOCK_FAILED_PARTIAL'
      WHEN confirmed_parts > 0 THEN 'BLOCK_ACTIVE_PARTIAL'
      ELSE 'ZERO_ACKS_REQUIRES_REVIEW'
    END AS assessment
  FROM measured
)
SELECT id, status, attempts, "lockedAt", confirmed_parts, total_parts, assessment
FROM classified
ORDER BY assessment, id;
-- END PREVIEW QUERY
COMMIT;
