-- 1055 — affiliates_user_id_unique (deployment-global on user_id) becomes
--        uniq_affiliates_org_user (org_id, user_id), so a person can be an
--        affiliate in more than one organisation.
--
-- WHAT WAS WRONG. migrations/0000_light_vance_astro.sql:9899 declared
--
--   CONSTRAINT "affiliates_user_id_unique" UNIQUE("user_id")
--
-- with no org_id in the key, from `userId: text("user_id").notNull().unique()` in
-- src/db/schema/billing/billing.ts. That is a bare global unique on a tenant-owned
-- table: it constrains the whole DEPLOYMENT, not the tenant.
--
-- AffiliateService.register (src/modules/billing/core/affiliate.service.ts) guards a
-- DIFFERENT key. It selects for an existing row on (org_id, user_membership_id) and
-- inserts when it finds none, so for a user who is already an affiliate in org A and
-- joins org B the pre-check passes, the insert hits the global constraint, nothing
-- catches it, and POST /billing/affiliate/register returns 500 with no diagnostic.
-- A user could be an affiliate in exactly one organisation in the entire deployment.
--
-- Measured against a database at journal head 677 (scratch_head_1010), one user and
-- two organisations, everything inside a rolled-back transaction:
--
--   NOTICE:  org A affiliate inserted OK
--   NOTICE:  DEFECT CONFIRMED: SQLSTATE=23505 /
--            duplicate key value violates unique constraint "affiliates_user_id_unique"
--
-- backend/CLAUDE.md §3 states the rule this violates directly: "Tenant-scoped
-- uniqueness is composite — a bare global .unique() lets one tenant's value block
-- every other org (cross-tenant DoS + info leak)."
--
-- WHY (org_id, user_id) AND NOT (org_id, user_membership_id). The service's own
-- pre-check names user_membership_id, but that column is NULLABLE and its FK is
-- ON DELETE SET NULL (fk_affiliates_org_user_mbr), so a unique over it stops
-- constraining a row the moment the membership is removed — and NULL keys never
-- collide, so the row could then be duplicated freely. user_id is NOT NULL and
-- permanent. The two keys are equivalent while a membership exists, because
-- organization_members already carries uniq_org_members_org_user (org_id, user_id),
-- so at most one membership per user per org can exist to point at. The service
-- pre-check moves to (org_id, user_id) in the same change so guard and constraint
-- name the same key.
--
-- WHY THIS CANNOT FAIL ON EXISTING DATA. The new constraint is strictly WEAKER than
-- the one it replaces: any set of rows satisfying UNIQUE(user_id) satisfies
-- UNIQUE(org_id, user_id) trivially, because the second key contains the first.
-- There is no backfill, no data to reconcile and no failure mode on a populated
-- table. Nothing references affiliates by a foreign key (pg_constraint reports zero
-- rows with confrelid = 'affiliates'::regclass), so the DROP has no dependent.
--
-- DROP THEN ADD inside drizzle-kit's single transaction (check-migration-discipline
-- rule 7). DROP CONSTRAINT takes ACCESS EXCLUSIVE on affiliates and holds it to
-- COMMIT, so no concurrent writer ever sees the table with neither constraint in
-- force, and any failure below rolls the whole file back with the old one intact.
-- ADD CONSTRAINT … UNIQUE builds its index under that same lock; the table holds at
-- most one row per affiliate per organisation, so the build is trivial.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Refuse rather than guess if the premise is false on this database.
DO $$
DECLARE
  offending bigint;
BEGIN
  IF to_regclass('public.affiliates') IS NULL THEN
    RAISE EXCEPTION '1055: table affiliates does not exist';
  END IF;

  -- The weaker key must already hold; it cannot fail, but read it rather than assume.
  SELECT count(*) INTO offending
    FROM (SELECT org_id, user_id FROM affiliates GROUP BY org_id, user_id HAVING count(*) > 1) d;
  IF offending > 0 THEN
    RAISE EXCEPTION
      '1055: % (org_id, user_id) pair(s) are already duplicated in affiliates; the new constraint cannot be created',
      offending;
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "affiliates_user_id_unique";
--> statement-breakpoint

ALTER TABLE "affiliates"
  ADD CONSTRAINT "uniq_affiliates_org_user" UNIQUE ("org_id", "user_id");
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success
-- over a statement that did nothing, and IF EXISTS hides a no-op.
DO $$
DECLARE
  new_def text;
  old_still_there boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO new_def
    FROM pg_constraint
   WHERE conrelid = 'affiliates'::regclass AND conname = 'uniq_affiliates_org_user';

  IF new_def IS NULL THEN
    RAISE EXCEPTION '1055: uniq_affiliates_org_user does not exist after this migration';
  END IF;
  IF new_def !~ 'UNIQUE \(org_id, user_id\)' THEN
    RAISE EXCEPTION '1055: uniq_affiliates_org_user has the wrong key (%)', new_def;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'affiliates'::regclass AND conname = 'affiliates_user_id_unique'
  ) INTO old_still_there;
  IF old_still_there THEN
    RAISE EXCEPTION
      '1055: affiliates_user_id_unique is still present; the deployment-global constraint was not dropped';
  END IF;
END
$$;
