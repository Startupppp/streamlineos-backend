-- Rollback for migration 1134.
--
-- Both indexes live in schema "build", not public: test_cases and test_runs are
-- declared through `pgSchema("build")`, and an index sits in its table's schema.
-- An unqualified DROP INDEX would find nothing and report success, leaving the
-- indexes in place.
--
-- Dropping them costs no data. The keyset pages they serve fall back to a scan.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_runs_org_project_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_cases_org_project_id";
