-- 1347 — Knowledge base: extend the document unlink trigger to the four scanned metadata fields
--
-- 1201 added app.hr_document_unlink_when_unpublishable, fired by AFTER UPDATE OF
-- "classification", "user_id", "uploaded_by", "type", "is_active", "metadata". None of
-- those are the four fields (name, description, category, tags) that
-- kb-linked-document-search.ts feeds into the search tsvector and that
-- document-pii-scan.ts scans for personal identifiers before a publish. A direct SQL
-- write to any of those four columns on a linked document escaped the trigger entirely.
--
-- This migration does two things:
--   1. Replaces the trigger function with a version that also fires the unlink when one
--      of the four scanned fields changes and the new combined text carries a recognised
--      personal-identifier pattern (Aadhaar-like, PAN, IFSC). The check is approximate —
--      no Verhoeff digit for Aadhaar, no keyword context for bank accounts — because the
--      PL/pgSQL layer is a backstop; document-pii-scan.ts in the application layer is
--      the authoritative scanner. The WHEN clause is dropped and the publishability
--      short-circuit is moved into the function body so both conditions are evaluated.
--   2. Extends the trigger's OF column list to include "name", "description", "category",
--      "tags", driven by SCANNED_DOCUMENT_FIELDS in document-pii-scan.ts. The spec
--      1347-document-guard-scanned-field-coverage.spec.ts asserts that the column list
--      matches that constant, so a new scanned field fails the spec and signals a
--      follow-up migration is needed.
--
-- SECURITY DEFINER: not needed. The trigger fires during an UPDATE to public.documents,
-- which always runs either as streamline_app inside a tenant transaction (app.organization_id
-- GUC set) or as streamline_admin (BYPASSRLS). Neither path is a @Public() route that
-- arrives without a tenant context. The function writes to kb_linked_documents and
-- audit_logs using NEW.org_id explicitly; both accesses succeed under both principals.
-- The pattern from 1057 (SECURITY DEFINER for a @Public() webhook resolver) does not
-- apply here.
--
-- Rollback: replaces the function and trigger with their 1201 shape. No data is touched
-- in either direction.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'documents'
      AND t.tgname = 'trg_documents_unlink_when_unpublishable'
  ) THEN
    RAISE EXCEPTION '1347 precondition: trg_documents_unlink_when_unpublishable is absent from public.documents — apply migration 1201 before this one';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.hr_document_unlink_when_unpublishable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected     integer;
  needs_unlink boolean := false;
  scanned_text text;
BEGIN
  IF app.hr_document_is_publishable(OLD) AND NOT app.hr_document_is_publishable(NEW) THEN
    needs_unlink := true;
  END IF;

  IF NOT needs_unlink
     AND app.hr_document_is_publishable(NEW)
     AND (   OLD.name        IS DISTINCT FROM NEW.name
          OR OLD.description IS DISTINCT FROM NEW.description
          OR OLD.category    IS DISTINCT FROM NEW.category
          OR OLD.tags        IS DISTINCT FROM NEW.tags)
  THEN
    scanned_text := coalesce(NEW.name, '')
                 || ' ' || coalesce(NEW.description, '')
                 || ' ' || coalesce(NEW.category, '')
                 || ' ' || coalesce(array_to_string(NEW.tags, ' '), '');
    needs_unlink :=
      scanned_text ~ '(^|[^[:digit:]])[2-9][[:digit:]]{3}[[:space:]\-]?[[:digit:]]{4}[[:space:]\-]?[[:digit:]]{4}([^[:digit:]]|$)'
      OR upper(scanned_text) ~ '(^|[^[:alnum:]])[A-Z]{5}[[:digit:]]{4}[A-Z]([^[:alnum:]]|$)'
      OR upper(scanned_text) ~ '(^|[^[:alnum:]])[A-Z]{4}0[[:alnum:]]{6}([^[:alnum:]]|$)';
  END IF;

  IF NOT needs_unlink THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS "trg_documents_unlink_when_unpublishable" ON "public"."documents";
--> statement-breakpoint

CREATE TRIGGER "trg_documents_unlink_when_unpublishable"
  AFTER UPDATE OF "classification", "user_id", "uploaded_by", "type", "is_active", "metadata",
                  "name", "description", "category", "tags" ON "public"."documents"
  FOR EACH ROW
  EXECUTE FUNCTION app.hr_document_unlink_when_unpublishable();
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname = 'hr_document_unlink_when_unpublishable'
      AND p.prosrc LIKE '%scanned_text%'
  ), '1347 post-check: app.hr_document_unlink_when_unpublishable must contain the scanned_text PII path added by this migration';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'documents'
      AND t.tgname = 'trg_documents_unlink_when_unpublishable'
      AND (t.tgtype & 2) = 0
      AND t.tgqual IS NULL
  ), '1347 post-check: trg_documents_unlink_when_unpublishable must be an AFTER trigger without a WHEN filter';
END $$;
