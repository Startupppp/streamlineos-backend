-- Postcondition verification for migration 1149.
-- Read-only. Run after applying 1149. Every query must return the stated result.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Expect 1. client_visible column must exist with the correct type.
SELECT count(*) AS client_visible_col_exists
FROM information_schema.columns
WHERE table_schema = 'build'
  AND table_name   = 'change_requests'
  AND column_name  = 'client_visible'
  AND data_type    = 'boolean'
  AND column_default = 'false';
--> statement-breakpoint

-- Expect 1. release_id column must exist as nullable integer.
SELECT count(*) AS release_id_col_exists
FROM information_schema.columns
WHERE table_schema = 'build'
  AND table_name   = 'change_requests'
  AND column_name  = 'release_id'
  AND data_type    = 'integer'
  AND is_nullable  = 'YES';
--> statement-breakpoint

-- Expect 1. Partial index on org_id + release_id must exist.
SELECT count(*) AS release_index_exists
FROM pg_indexes
WHERE schemaname = 'build'
  AND tablename  = 'change_requests'
  AND indexname  = 'idx_change_requests_org_release';
--> statement-breakpoint

-- Expect 1. Partial index on org_id + client_visible must exist.
SELECT count(*) AS client_visible_index_exists
FROM pg_indexes
WHERE schemaname = 'build'
  AND tablename  = 'change_requests'
  AND indexname  = 'idx_change_requests_org_client_visible';
--> statement-breakpoint

-- Expect 1. FK constraint must exist (NOT VALID until validated separately).
SELECT count(*) AS fk_exists
FROM information_schema.table_constraints
WHERE constraint_schema = 'build'
  AND table_name        = 'change_requests'
  AND constraint_name   = 'fk_change_requests_org_release'
  AND constraint_type   = 'FOREIGN KEY';
--> statement-breakpoint

-- Expect 0. No existing row may have a release_id that violates the FK once validated.
-- Run this before issuing VALIDATE CONSTRAINT to confirm the data is clean.
SELECT count(*) AS fk_violators
FROM build.change_requests cr
WHERE cr.release_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM build.project_releases pr
    WHERE pr.org_id = cr.org_id
      AND pr.id     = cr.release_id
  );
