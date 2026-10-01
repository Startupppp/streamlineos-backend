-- Rollback for 1347_kb_hr_documents_guard_scanned_fields.
-- Restores app.hr_document_unlink_when_unpublishable and
-- trg_documents_unlink_when_unpublishable to their 1201 shape: the function loses
-- the scanned-field PII path and the trigger loses the four scanned column names.
-- No data is touched; active links that were auto-unpublished by the PII path during
-- the window 1347 was live remain unpublished — they must be reviewed manually.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_documents_unlink_when_unpublishable" ON "public"."documents";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.hr_document_unlink_when_unpublishable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.kb_linked_documents
     SET status = CASE WHEN NEW.is_active THEN 'unpublished' ELSE 'source_removed' END,
         unpublished_at = now(),
         unpublish_reason = 'source_no_longer_publishable',
         source_removed_at = CASE WHEN NEW.is_active THEN NULL ELSE now() END,
         updated_at = now()
   WHERE org_id = NEW.org_id AND document_id = NEW.id AND status = 'active';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    INSERT INTO public.audit_logs (action, org_id, target_id, target_type, resource_type, resource_id, metadata, is_platform_event)
    VALUES (
      'kb.hr_link.auto_unpublished', NEW.org_id, NEW.id::text, 'document', 'document', NEW.id::text,
      jsonb_build_object('systemActor', 'document-guard-trigger', 'reason', 'source_no_longer_publishable',
                         'documentId', NEW.id, 'linksAffected', affected),
      false
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER "trg_documents_unlink_when_unpublishable"
  AFTER UPDATE OF "classification", "user_id", "uploaded_by", "type", "is_active", "metadata" ON "public"."documents"
  FOR EACH ROW
  WHEN (app.hr_document_is_publishable(OLD) AND NOT app.hr_document_is_publishable(NEW))
  EXECUTE FUNCTION app.hr_document_unlink_when_unpublishable();
