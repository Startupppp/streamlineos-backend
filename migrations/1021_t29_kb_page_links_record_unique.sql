-- 1010: give kb_page_links' record-link grain the uniqueness its dedupe assumes.
--
-- kb_page_links carries two grains in one table:
--   page -> page   target_page_id set, target_type = 'page'
--   page -> record target_page_id NULL, target_type/target_id a polymorphic pointer
--
-- uniq_kb_page_links_source_target is (source_page_id, target_page_id). For the
-- record grain target_page_id is NULL and NULLs are distinct in a btree, so that
-- index constrains nothing at all. KbPageRecordLinksService.add reads for an
-- existing (org_id, source_page_id, target_type, target_id) and throws 409 if it
-- finds one -- a read-then-insert with no unique behind it, so two concurrent
-- adds of the same record link both read nothing and both insert.
--
-- The partial unique index below is exactly the tuple that service dedupes on,
-- restricted to the record grain so the page grain is untouched.
--
-- On the polymorphic pointer itself: target_type ranges over seven entity types
-- in five different modules (crm_lead, crm_deal, crm_contact, project,
-- project_ticket, support_ticket, hr_employee -- RECORD_LINK_TARGET_TYPES in
-- modules/kb/wiki/dto/kb-page-record-links.schemas.ts), and target_id is text
-- because those tables do not share a key type. An exclusive arc would need
-- seven nullable FK columns on this table reaching into five other modules'
-- schemas, which backend/CLAUDE.md section 1 forbids (cross-module access goes
-- through the other module's service, never its schema). It stays a
-- display/dedupe pointer, which section 3 grandfathers explicitly, and nothing
-- resolves, joins or cascades a record through it: KbPageRecordLinksService
-- only ever joins kb_page_links -> kb_pages (its own composite tenant FK) and
-- filters on the pair as opaque text.
--
-- CREATE INDEX rather than CONCURRENTLY: drizzle-kit migrate wraps the file in a
-- transaction (discipline rule 7). lock_timeout bounds the wait.

SET lock_timeout = '5s';
--> statement-breakpoint

DELETE FROM "kb_page_links" a
USING "kb_page_links" b
WHERE a."target_id" IS NOT NULL
  AND b."target_id" IS NOT NULL
  AND a."org_id" = b."org_id"
  AND a."source_page_id" = b."source_page_id"
  AND a."target_type" = b."target_type"
  AND a."target_id" = b."target_id"
  AND a."id" > b."id";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_links_org_source_record"
  ON "kb_page_links" ("org_id", "source_page_id", "target_type", "target_id")
  WHERE "target_id" IS NOT NULL;
