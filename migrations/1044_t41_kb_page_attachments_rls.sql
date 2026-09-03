-- 1044: tenant isolation for kb_page_attachments, which shipped in 1042 with none.
--
-- Found by `db:verify-rls` run against a scratch database bootstrapped to head
-- (667/667): coverage 982 of 989 tenant-scoped tables, one IN-SCOPE MISSING.
-- Every other kb table carries a tenant_isolation policy; this one was created
-- with the composite FK and the (org_id, id) anchor but no ENABLE ROW LEVEL
-- SECURITY and no policy at all.
--
-- That is not cosmetic. `db-bootstrap-app-role.mjs` runs
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`,
-- so streamline_app holds full DML on every table a migration adds from the
-- moment it exists. With no policy the only thing standing between one tenant
-- and another tenant's attachment ledger -- file names, storage keys, uploader
-- ids -- is the org_id predicate the service happens to write. That is the
-- application-layer check BE/CLAUDE.md section 5 calls advisory.
--
-- The predicate mirrors kb_article_attachments, the wiki twin this table was
-- deliberately shaped after: `app.current_org_id()` on both sides, not the
-- `_or_null` variant kb_pages uses. kb_pages needs the nullable form because a
-- public help-centre page is read with no tenant GUC via public_token; an
-- attachment row is never read on that path, so the strict form is correct and
-- a NULL GUC must see nothing rather than everything.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.kb_page_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.kb_page_attachments;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.kb_page_attachments
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
