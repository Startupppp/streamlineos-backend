-- Wave 2 — module-authority reconciliation backfill.
-- Materializes org_modules rows from the current organizations.enabled_modules array so BOTH
-- enforcement paths agree: ModuleGuard (reads the array allowlist, deny-by-default) and
-- authorize.ts/isModuleEnabled (reads org_modules, allow-by-default). See
-- docs/schema-migration/wave-2-module-authority-unify.md for the full design + danger analysis.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING never clobbers an explicit admin toggle already in org_modules.
-- ⚠️ BEHAVIORAL CHANGE ON APPLY: writing enabled=false rows makes the org_modules/authorize path
--    DENY modules that are not in an org's array (today it allows-by-default when no row exists).
--    This CLOSES a real gap (a disabled module's @RequirePermission-only endpoints are reachable
--    today) but can block a module an org silently relied on. RUN THE PARITY CHECK BELOW FIRST,
--    on a Neon branch, and get explicit sign-off before applying to prod.
--
-- Vocabulary mapping = EntitlementsService.MODULE_KEY_TO_ORG_MODULE (entitlements.service.ts:30).
-- Core/always-on keys (kb) have no array-name and get NO row (listModules marks them core:true).

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — PARITY CHECK (READ-ONLY). Run BEFORE. Every row = a divergence between the two paths.
-- COALESCE(om.enabled, true) models isModuleEnabled's current allow-by-default.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT o.id AS org_id,
--        m.module_key,
--        (m.array_name = ANY(COALESCE(o.enabled_modules, '{}'))) AS array_enabled,
--        COALESCE(om.enabled, true) AS orgmod_enabled_effective
-- FROM organizations o
-- CROSS JOIN (VALUES
--   ('hr','HR'), ('crm','CRM'), ('projects','PROJECTS'), ('inventory','INVENTORY'),
--   ('accounting','FINANCE'), ('support','HELPDESK'), ('surveys','SURVEYS'),
--   ('payroll','PAYROLL'), ('sign','SIGN')
-- ) AS m(module_key, array_name)
-- LEFT JOIN org_modules om ON om.org_id = o.id AND om.module_key = m.module_key
-- WHERE (m.array_name = ANY(COALESCE(o.enabled_modules, '{}')))
--       IS DISTINCT FROM COALESCE(om.enabled, true)
-- ORDER BY o.id, m.module_key;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — BACKFILL. Materialize one row per (org, non-core module) reflecting the array verdict.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO org_modules (org_id, module_key, enabled, enabled_by)
SELECT o.id,
       m.module_key,
       (m.array_name = ANY(COALESCE(o.enabled_modules, '{}'))) AS enabled,
       'system'
FROM organizations o
CROSS JOIN (VALUES
  ('hr','HR'),
  ('crm','CRM'),
  ('projects','PROJECTS'),
  ('inventory','INVENTORY'),
  ('accounting','FINANCE'),
  ('support','HELPDESK'),
  ('surveys','SURVEYS'),
  ('payroll','PAYROLL'),
  ('sign','SIGN')
) AS m(module_key, array_name)
ON CONFLICT (org_id, module_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — POST-VERIFY (READ-ONLY). After backfill the parity query above must return ZERO rows
-- (every module now has an explicit org_modules row matching the array). Then converge the read
-- paths per the design doc, keep dual-write during overlap, and contract the array in Wave 9.
-- ─────────────────────────────────────────────────────────────────────────────
