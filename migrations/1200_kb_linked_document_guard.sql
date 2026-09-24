-- 1200 — Knowledge base: the database's own guard on what may be linked (HRMS-KB PR 2)
--
-- The tables (1199) hold links. This migration is what keeps a personal document from ever being one, in
-- the database itself, so a writer that has never heard of this feature still cannot leave a personal
-- document linked:
--   * `app.hr_document_is_publishable(documents)` is the single definition. It has a TypeScript twin,
--     `isPublishableDocument` in src/modules/hr/performance/documents-helpers.ts; documents-publishable-
--     parity.db.spec.ts feeds 1,600 combinations through both and requires the same answer.
--   * BEFORE INSERT/UPDATE on a link refuses to make it `active` unless its document is publishable.
--   * AFTER UPDATE on `documents` unlinks (and audits) the moment a linked document stops being
--     publishable. This is what catches the CSV import, which can rewrite `type` on a match.
-- Hard deletes are handled by the foreign key (SET NULL on `document_id`), not by a DELETE trigger: a
-- trigger that updates link rows while an organisation-purge cascade is deleting them is exactly the
-- shape that raises "tuple to be deleted was already modified". A link whose document is gone is invisible
-- to readers (they join the document) and the purge job (PR 7) marks it `source_removed`.
--
-- No data is touched: the functions and triggers only act when a link exists, and none does yet.
--
-- Rollback: migrations/rollback/1200_kb_linked_document_guard.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

-- The single database definition of "this document may be linked". Mirrors isPublishableDocument in
-- src/modules/hr/performance/documents-helpers.ts. coalesce(..., false): a NULL comparison (an owner and no
-- recorded uploader) must read as "not publishable", never as "unknown, allow".
CREATE OR REPLACE FUNCTION app.hr_document_is_publishable(d public.documents)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    d.is_active
    AND d.classification IN ('INTERNAL', 'RESTRICTED')
    AND d.type IN ('POLICY', 'OTHER')
    AND (d.user_id IS NULL OR d.user_id = d.uploaded_by)
    AND NOT (coalesce(d.metadata, '{}'::jsonb) ?| ARRAY['candidateId', 'offerId']),
    false
  )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.hr_document_is_publishable(public.documents) TO streamline_app;
--> statement-breakpoint

-- BEFORE INSERT/UPDATE on a link: an ACTIVE link needs a publishable document. A link whose document_id is
-- NULL is allowed through, because that is exactly what the foreign key's SET NULL writes when a document
-- is hard-deleted, and refusing it here would block the delete.
CREATE OR REPLACE FUNCTION app.kb_linked_document_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  doc public.documents;
BEGIN
  IF NEW.status <> 'active' OR NEW.document_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO doc FROM public.documents WHERE org_id = NEW.org_id AND id = NEW.document_id;
  IF NOT FOUND OR NOT app.hr_document_is_publishable(doc) THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_PUBLISHABLE: document % cannot be linked into the knowledge base', NEW.document_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_kb_linked_documents_guard" ON "public"."kb_linked_documents";
--> statement-breakpoint
CREATE TRIGGER "trg_kb_linked_documents_guard"
  BEFORE INSERT OR UPDATE OF "status", "document_id" ON "public"."kb_linked_documents"
  FOR EACH ROW EXECUTE FUNCTION app.kb_linked_document_guard();
--> statement-breakpoint

-- AFTER UPDATE on a document: the moment a linked document stops being publishable, its live links stop
-- being live, in the same transaction, and the change is audited. The WHEN clause makes it a transition
-- check, so an ordinary edit of a PERSONAL document (nearly every update) costs nothing.
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
DROP TRIGGER IF EXISTS "trg_documents_unlink_when_unpublishable" ON "public"."documents";
--> statement-breakpoint
CREATE TRIGGER "trg_documents_unlink_when_unpublishable"
  AFTER UPDATE OF "classification", "user_id", "uploaded_by", "type", "is_active", "metadata" ON "public"."documents"
  FOR EACH ROW
  WHEN (app.hr_document_is_publishable(OLD) AND NOT app.hr_document_is_publishable(NEW))
  EXECUTE FUNCTION app.hr_document_unlink_when_unpublishable();
