-- 1132 — at most one default payslip template per organisation.
--
-- `2026-09-20-get-route-writes-lane.md` left this open as "`payslip_templates` has no unique
-- constraint on `(org_id, layout)`, so two concurrent first reads seed six templates".
-- The race is real — `payslip-templates.service.ts:25-55` reads `limit 1`, finds nothing and
-- inserts three defaults, so two concurrent first GETs both see empty and both seed — but
-- **the proposed key is wrong and is deliberately not what this migration adds.**
-- `create()` (`:78-91`) lets a customer create as many templates on one layout as they like;
-- a unique index on `(org_id, layout)` would reject that with a 23505 on a legitimate action.
--
-- The invariant that is actually true is one default per org, and every write site already
-- enforces it in application code: `create()` demotes every other row before inserting a
-- default (`:80-85`), `update()` demotes every row but the target (`:109-114`), and
-- `delete()` refuses to remove the default outright (`:139`). Three call sites maintaining an
-- invariant the database does not know about is the definition of an unenforced invariant.
-- Writing it down here closes the seed race as a consequence: the seed inserts exactly one
-- `is_default` row, so the second concurrent seeder loses on this index instead of doubling
-- the set.
--
-- Partial, not plain: only the default row is constrained, and the non-default rows an org
-- accumulates are untouched.
--
-- Measured against production before writing this: `payslip_templates` holds **0 rows**, so
-- there is nothing to deduplicate first and the index cannot fail to build. The equivalent
-- backfill on a database that does hold rows would have to pick a winner per org, which is a
-- product decision, not a migration — hence the guard below, which refuses rather than
-- guesses.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending FROM (
    SELECT "org_id" FROM "payslip_templates"
     WHERE "is_default"
     GROUP BY "org_id"
    HAVING count(*) > 1
  ) AS duplicated;
  IF offending > 0 THEN
    RAISE EXCEPTION
      '1132: % organisation(s) already hold more than one default payslip template. Pick a winner per org before applying this.',
      offending;
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payslip_templates_org_default"
  ON "payslip_templates" ("org_id")
  WHERE "is_default";
