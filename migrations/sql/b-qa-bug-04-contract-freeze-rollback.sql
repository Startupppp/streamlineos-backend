-- Phase 2 / Workstream B / P0 #7 — rollback of b-qa-bug-04-contract-freeze.sql.
--
-- Restores the write grant on build.bugs so the legacy QA bug routes work
-- again. Pair it with a deploy of the pre-cutover application build; the grant
-- alone does not re-point the readers.
--
-- The VALIDATE on fk_test_run_results_org_work_item is deliberately not
-- reversed. It only proved that the existing evidence pointers are sound, and
-- undoing it would weaken a constraint for no benefit.

SET lock_timeout = '5s';
--> statement-breakpoint

GRANT INSERT, UPDATE, DELETE ON "build"."bugs" TO streamline_app;
