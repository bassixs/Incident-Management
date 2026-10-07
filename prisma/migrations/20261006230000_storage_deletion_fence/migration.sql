-- Permanent per-key fence in SystemSetting. Reference writers and retirement
-- serialize only on that key, never on a whole inbox/outbox/session table.
CREATE OR REPLACE FUNCTION guard_retired_storage_reference() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $body$
DECLARE storage_key text; previous_document jsonb := '{}';
BEGIN
  IF TG_OP = 'UPDATE' THEN previous_document := to_jsonb(OLD); END IF;
  FOR storage_key IN
    SELECT DISTINCT v #>> '{}' FROM jsonb_path_query(to_jsonb(NEW), '$.**.storageKey') v
    WHERE jsonb_typeof(v) = 'string' AND (v #>> '{}') <> ''
      AND NOT jsonb_path_exists(previous_document, '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', v))
    ORDER BY 1
  LOOP
    -- A transaction retaining an older snapshot cannot prove fence absence.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'STORAGE_REFERENCE_REQUIRES_READ_COMMITTED' USING ERRCODE='55000';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(storage_key, 724091));
    IF EXISTS (SELECT 1 FROM "SystemSetting"
      WHERE key = 'retention.file-fence.v1:' || encode(sha256(convert_to(storage_key, 'UTF8')), 'hex')) THEN
      RAISE EXCEPTION 'STORAGE_KEY_RETIRED' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$body$;

-- statement
DO $body$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['IncidentAttachment','AnswerAttachment','ClarificationAttachment',
    'OutboundMessage','OperatorSession','PrivateWorkItem','InboundUpdate']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_retired_storage ON %I', table_name);
    EXECUTE format('CREATE TRIGGER guard_retired_storage BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_retired_storage_reference()', table_name);
  END LOOP;
END;
$body$;
