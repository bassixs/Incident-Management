DO $$
DECLARE before_row jsonb; after_row jsonb; history jsonb;
BEGIN
  SELECT value::jsonb->'incident',value::jsonb->'migrations' INTO before_row,history FROM "SystemSetting" WHERE key='synthetic-policy-migration-control';
  SELECT to_jsonb(i) INTO after_row FROM "Incident" i WHERE id='policy-control';
  IF after_row - ARRAY['slaPolicy','slaDeliveredAt','workingDeadlineQueuedAt'] <> before_row THEN RAISE EXCEPTION 'Historical incident changed'; END IF;
  IF after_row->>'slaPolicy' <> 'LEGACY' OR after_row->>'slaDeliveredAt' IS NOT NULL OR after_row->>'workingDeadlineQueuedAt' IS NOT NULL THEN RAISE EXCEPTION 'Incorrect migration policy'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(history) h LEFT JOIN "_prisma_migrations" m ON m.migration_name=h->>'name' WHERE m.checksum IS DISTINCT FROM h->>'checksum') THEN RAISE EXCEPTION 'Historical checksums changed'; END IF;
  IF EXISTS (SELECT 1 FROM "IncidentAssignmentCycle") THEN RAISE EXCEPTION 'Invented historical assignments'; END IF;
END $$;
