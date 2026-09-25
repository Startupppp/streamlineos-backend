-- Rollback for 1201_kb_linked_document_guard. Removes the guard only; links and documents are untouched, so
-- after this a personal document COULD be linked by a writer that bypasses the application. Roll it back
-- only together with the feature.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_documents_unlink_when_unpublishable" ON "public"."documents";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_kb_linked_documents_guard" ON "public"."kb_linked_documents";
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.hr_document_unlink_when_unpublishable();
--> statement-breakpoint
DROP FUNCTION IF EXISTS app.kb_linked_document_guard();
--> statement-breakpoint
DROP FUNCTION IF EXISTS app.hr_document_is_publishable(public.documents);
