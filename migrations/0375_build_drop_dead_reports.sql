-- 0375 — Build: drop the dead `reports` table.
--
-- PROOF OF DEATH (re-verified 2026-07-31, not inherited from an earlier audit):
--   1. Query references: `grep -rnE "(from|insert|update|delete)\(\s*reports\s*\)" backend/src`
--      returns ZERO matches. The Drizzle symbol is never queried.
--   2. The only remaining references to the symbol are its own definition in
--      db/schema/build/core.ts and the schema barrels that re-export it.
--   3. Every other repo hit for the word "reports" is a different concept:
--      `accounting/reports` routes, `support:reports:overview` cache keys,
--      `projectReports` (a service, not this table), and prose in seeds/specs.
--   4. BARE SIDE-EFFECT IMPORT CHECK: `grep -rnE '^\s*import\s+"[^"]+";' backend/src`
--      returns only 5 hits, all `import "reflect-metadata"`. No module is pulled in
--      for side effects in a way a from-based scanner would miss. This check exists
--      because a previous cleanup in this repo deleted a live file by missing exactly
--      that form.
--
-- Build's actual reporting is served by `projects-reports.service.ts`, which reads
-- `project_daily_snapshots`, `tickets`, `sprints` and `custom_states` — never this table.
--
-- The guard below refuses to drop a table that turns out to hold rows, so a
-- production database with unexpected data fails loudly instead of losing it.

SET statement_timeout = 0;

--> statement-breakpoint
DO $$
DECLARE
  row_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'reports' AND relkind = 'r') THEN
    RAISE NOTICE 'reports table already absent - nothing to do';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM reports' INTO row_count;

  IF row_count > 0 THEN
    RAISE EXCEPTION
      'refusing to drop reports - table holds % row(s). It was proven dead by code reference, not by row count; investigate before dropping.',
      row_count;
  END IF;

  RAISE NOTICE 'reports row count is 0 - safe to drop';
END $$;

--> statement-breakpoint
DROP TABLE IF EXISTS "reports";
