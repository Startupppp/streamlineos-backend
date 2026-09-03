-- 1044 DOWN -- removes tenant isolation from kb_page_attachments.
--
-- @security-regression: running this REOPENS a cross-tenant read. The table
-- shipped in 1042 with no policy at all, and it was measured before 1044:
-- as the non-owner streamline_app role with a tenant GUC set, tenant A read
-- BOTH organisations' rows -- file names, storage keys, uploader ids. That is
-- what this down-file restores. It exists because a migration with no rollback
-- path fails check:migration-rollback and because an operator is entitled to
-- reverse any migration, NOT because reversing this one is advisable.
--
-- `db-bootstrap-app-role.mjs` grants streamline_app full DML on every table a
-- migration adds, so with the policy gone the only remaining barrier is the
-- org_id predicate the service happens to write -- the application-layer check
-- BE/CLAUDE.md section 5 classifies as advisory.
--
-- The forward migration is idempotent (DROP POLICY IF EXISTS before CREATE),
-- so re-applying after this is safe and restores isolation.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.kb_page_attachments;
--> statement-breakpoint

ALTER TABLE public.kb_page_attachments DISABLE ROW LEVEL SECURITY;
