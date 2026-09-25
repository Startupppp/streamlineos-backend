-- Rollback for 1203 — remove only the grants this migration could have created.
--
-- A role that held `kb:ai:generate` before 1203 also holds `kb:pages:view` (no role held it at all on
-- 2026-09-25, measured across every tenant), so the predicate below is exact rather than merely safe.
-- Roles granted Ask by hand after 1203 and without page view are deliberately left alone.
SET lock_timeout = '5s';
--> statement-breakpoint

DELETE FROM "public"."role_permission_grants" a
WHERE a."permission_key" = 'kb:ai:generate'
  AND EXISTS (
    SELECT 1 FROM "public"."role_permission_grants" v
    WHERE v."org_id" = a."org_id"
      AND v."role_id" = a."role_id"
      AND v."permission_key" = 'kb:pages:view'
  );
--> statement-breakpoint
