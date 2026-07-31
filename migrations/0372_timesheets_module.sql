SET statement_timeout = 0;

-- =============================================================================
-- 0372 — promote `timesheets` to a first-class module
-- =============================================================================
-- Timesheets has its own permission catalog, controllers and routes, but was
-- never in MODULE_CATALOG. Every one of its controllers gates on
-- @RequireModule("build"), so it has been riding on the Build module: it has no
-- enablement row, no ownership, and no module-access surface of its own.
--
-- ORDER MATTERS, because ModuleGuard FAILS CLOSED. `isModuleEnabled` returns
-- false when a module key is absent from the org's map, so the moment a
-- controller switches to @RequireModule("timesheets") every timesheets endpoint
-- 403s for all non-owners unless an org_modules row already exists. And that row
-- cannot be inserted at all until the catalog row exists, because 0337 added
-- org_modules.module_key -> modules_catalog.module_key.
--
-- So: catalog row first, then backfill, and only afterwards may a controller
-- change its gate. This migration does the first two.
-- =============================================================================

INSERT INTO "modules_catalog" ("module_key", "name", "is_core", "is_paid_only", "sort_order")
VALUES ('timesheets', 'Timesheets', false, false, 12)
ON CONFLICT ("module_key") DO NOTHING;
--> statement-breakpoint

-- Every org that already has Build enabled implicitly had Timesheets, since the
-- controllers gate on "build". Grant them exactly what they already had —
-- enabling it for anyone else would be a silent expansion of access.
INSERT INTO "org_modules" ("org_id", "module_key", "enabled")
SELECT om."org_id", 'timesheets', om."enabled"
FROM "org_modules" om
WHERE om."module_key" = 'build'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Prove the precondition for switching the gate: no org may have Build enabled
-- without a matching Timesheets row, or its users would lose timesheets access
-- the moment a controller is re-gated.
DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM "org_modules" b
  WHERE b."module_key" = 'build'
    AND NOT EXISTS (
      SELECT 1 FROM "org_modules" t
      WHERE t."org_id" = b."org_id" AND t."module_key" = 'timesheets'
    );

  IF missing > 0 THEN
    RAISE EXCEPTION
      '0372: % org(s) have Build enabled but no timesheets row — re-gating would 403 them', missing;
  END IF;
END $$;
