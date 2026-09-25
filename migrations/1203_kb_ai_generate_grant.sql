-- 1203 — Ask KB: `kb:ai:generate` becomes the route key, granted to whoever could already Ask
--
-- The Ask routes were gated on `kb:pages:view`, so the ability to spend AI credit was inferred from
-- the ability to read a page. `kb:ai:generate` has existed in both permission catalogues since the
-- module was written and was bound to the help-centre authoring routes only; no role held it.
--
-- Moving the route key without this backfill would revoke Ask from every non-owner in every tenant.
-- Granting it to exactly the roles that already hold `kb:pages:view` preserves today's behaviour
-- to the row, and makes the capability separately revocable from tomorrow on: an administrator can
-- now take Ask away without taking the wiki away.
--
-- `scope` is copied from the source grant rather than defaulted, so a role limited to its own data
-- stays limited. Idempotent on uniq_role_permission_grants_role_key.
--
-- Rollback: migrations/rollback/1203_kb_ai_generate_grant.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.role_permission_grants') IS NULL THEN
    RAISE EXCEPTION '1203 precondition: public.role_permission_grants is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_role_permission_grants_role_key'
  ) THEN
    RAISE EXCEPTION '1203 precondition: uniq_role_permission_grants_role_key is absent — the backfill cannot be idempotent';
  END IF;
END $$;
--> statement-breakpoint

INSERT INTO "public"."role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT g."org_id", g."role_id", 'kb:ai:generate', g."scope"
FROM "public"."role_permission_grants" g
WHERE g."permission_key" = 'kb:pages:view'
ON CONFLICT ("org_id", "role_id", "permission_key") DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM "public"."role_permission_grants" v
  WHERE v."permission_key" = 'kb:pages:view'
    AND NOT EXISTS (
      SELECT 1 FROM "public"."role_permission_grants" a
      WHERE a."org_id" = v."org_id"
        AND a."role_id" = v."role_id"
        AND a."permission_key" = 'kb:ai:generate'
    );
  IF missing > 0 THEN
    RAISE EXCEPTION '1203 postcondition: % role(s) can read pages but cannot Ask — the backfill did not cover every grant', missing;
  END IF;
END $$;
--> statement-breakpoint
