-- Custom SQL migration file, put your code below! --

-- Commission plans that a payout can be reproduced from, and the trigger that
-- makes "reproduced" true rather than aspirational.
--
-- Phase 5 ticket 04. `commission_rules` and `commissions` (created for
-- `crm/deals.ts`) already store a commission scheme and cannot answer the only
-- question a disputed payslip asks: what was the rule on the day this was
-- earned? `commission_rules` has one mutable row per rule and no dating at all,
-- so raising a rate restates every historical payout that recomputes against it.
-- `commissions` stores `commission_rate` and `commission_amount` as `decimal`,
-- the column type this database moved off for money after it produced rounding
-- drift on summed forecasts -- see the generated `deals.value` column and the
-- comment on `deals.value_minor`.
--
-- Nothing here drops or alters those two tables. `modules/sales` still reads
-- them and this migration is not the place to find out what else does.
--
-- Three decisions are encoded below and none of them are stylistic:
--
--  1. There is no `effective_to` on a plan version. The version in force on a
--     date is the one with the greatest `effective_from` at or before it, which
--     makes gaps and overlaps unrepresentable rather than merely discouraged --
--     there is no second date to contradict the first, and no interval
--     constraint anybody can forget to write. `uniq_crm_commission_plan_versions_effective`
--     is what keeps "the greatest" from being ambiguous.
--
--  2. `sealed_at` plus `trg_crm_commission_plan_versions_seal`. The service
--     refuses to edit a sealed version so the caller gets a readable 409, but a
--     rule enforced only in a service is a rule enforced only for callers who
--     went through it. The trigger raises on any UPDATE to `rules`,
--     `effective_from` or `version_number` after a version has been earned
--     against, and on DELETE, for every writer including psql.
--
--  3. Money is `bigint` minor units end to end. There is no `numeric` column in
--     this migration and no rate stored as a fraction; rates are integer basis
--     points inside the `rules` document.
--
-- Authored by hand from the Drizzle declarations in
-- `src/db/schema/crm/commission.ts`, column for column: `drizzle-kit generate`
-- is unusable in this repository (see 0205).

SET lock_timeout = '5s';

-- ── Plans ───────────────────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_plans" (
  "plan_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,

  -- Copied onto every earning rather than joined at read time: a tenant can
  -- change its currency, and a payout must keep reporting the units it was
  -- actually computed in.
  "currency" text DEFAULT 'INR' NOT NULL,

  -- Stops new versions and new assignments. Never deletes history: earnings
  -- reference the plan with ON DELETE RESTRICT for exactly this reason.
  "retired_on" date,

  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_plans_org_name"
  ON "crm_commission_plans" ("org_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_plans_org"
  ON "crm_commission_plans" ("org_id", "retired_on");

-- ── Versions: the dated, sealable rule sets ─────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_plan_versions" (
  "plan_version_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "version_number" integer NOT NULL,

  -- The first day this rule set governs, and the only date an earning needs in
  -- order to select it.
  "effective_from" date NOT NULL,

  -- Rates, tier boundaries, quota, accelerators and cap. Data, not code: no
  -- deploy changes what a tenant's plan pays.
  "rules" jsonb NOT NULL,

  -- Non-null from the moment the first earning cited this version. The trigger
  -- below reads it; nothing else may clear it.
  "sealed_at" timestamp,

  "note" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,

  -- Cheap structural guards on the rule document. Not a schema check -- the DTO
  -- and `commission-rules.ts` validate the tiers -- but these two catch the
  -- shapes that would make the evaluator throw on every read of a stored row.
  CONSTRAINT "chk_crm_commission_plan_versions_rules_object"
    CHECK (jsonb_typeof("rules") = 'object'),
  CONSTRAINT "chk_crm_commission_plan_versions_rules_tiers"
    CHECK (jsonb_typeof("rules" -> 'tiers') = 'array'
           AND jsonb_array_length("rules" -> 'tiers') >= 1),
  CONSTRAINT "chk_crm_commission_plan_versions_number"
    CHECK ("version_number" >= 1)
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_plan_versions_number"
  ON "crm_commission_plan_versions" ("org_id", "plan_id", "version_number");

--> statement-breakpoint
-- Two versions starting on the same day would make "the greatest effective_from
-- at or before D" ambiguous, and the payout would then depend on which row the
-- planner happened to return first. That is the failure this index exists for.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_plan_versions_effective"
  ON "crm_commission_plan_versions" ("org_id", "plan_id", "effective_from");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_plan_versions_lookup"
  ON "crm_commission_plan_versions" ("org_id", "plan_id", "effective_from" DESC);

--> statement-breakpoint
-- The whole ticket, as a constraint.
--
-- Once a version has paid somebody, its rules and its dates are history. An
-- UPDATE that changes them is refused rather than logged: a warning would leave
-- the row changed, and every earning citing it would silently start reproducing
-- a different number than the one on the payslip.
--
-- `note` and `updated_at` stay writable so a sealed version can still be
-- annotated -- explaining a plan is not restating it. `sealed_at` itself may go
-- NULL -> NOT NULL and no further, so nothing can un-seal a version by writing
-- to it directly.
CREATE OR REPLACE FUNCTION "crm_commission_plan_version_seal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sealed_at" IS NOT NULL THEN
      RAISE EXCEPTION
        'commission plan version % has been earned against and cannot be deleted',
        OLD."plan_version_id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."rules" IS DISTINCT FROM OLD."rules"
    OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
    OR NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
  ) THEN
    RAISE EXCEPTION
      'commission plan version % has been earned against; publish a new version instead of restating this one',
      OLD."plan_version_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_crm_commission_plan_versions_seal" ON "crm_commission_plan_versions";
--> statement-breakpoint
CREATE TRIGGER "trg_crm_commission_plan_versions_seal"
  BEFORE UPDATE OR DELETE ON "crm_commission_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "crm_commission_plan_version_seal_guard"();

-- ── Assignments ─────────────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_assignments" (
  "assignment_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "user_id" text NOT NULL,
  "effective_from" date NOT NULL,

  -- Inclusive last day; NULL while the person is still on the plan.
  "effective_to" date,

  -- A quota is a property of the individual's target, not of the scheme: two
  -- reps on identical rules routinely carry different numbers, and forking the
  -- plan version per rep would make the plan unreadable.
  "quota_override_minor" bigint,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "chk_crm_commission_assignments_dates"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "chk_crm_commission_assignments_quota"
    CHECK ("quota_override_minor" IS NULL OR "quota_override_minor" > 0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_assignments_start"
  ON "crm_commission_assignments" ("org_id", "user_id", "effective_from");

--> statement-breakpoint
-- At most one open assignment per person. A second concurrent one would mean a
-- deal earns twice and neither payout is wrong on its own terms.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_assignments_open"
  ON "crm_commission_assignments" ("org_id", "user_id")
  WHERE "effective_to" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_assignments_lookup"
  ON "crm_commission_assignments" ("org_id", "user_id", "effective_from" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_assignments_plan"
  ON "crm_commission_assignments" ("org_id", "plan_id");

-- ── Earnings ────────────────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_earnings" (
  "earning_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,

  -- The version this money was actually computed from, stored rather than
  -- re-resolved on read. Re-resolution is correct today and starts answering
  -- differently the moment somebody backdates a version -- which is precisely
  -- the change this table exists to make visible.
  "plan_version_id" text NOT NULL,

  "user_id" text NOT NULL,
  "earned_on" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,

  "source_type" text NOT NULL,
  "source_id" text NOT NULL,

  "basis_minor" bigint NOT NULL,
  "prior_basis_minor" bigint DEFAULT 0 NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,

  -- Blended rate, derived and stored for reporting. A marginal band table has
  -- no single rate, so a reader recomputing it from one tier would get a
  -- different number and conclude the row was wrong.
  "effective_rate_bps" integer DEFAULT 0 NOT NULL,
  "attainment_bps" integer,

  -- The slice-by-slice trace, plus the rule document as it stood. A dispute is
  -- answered by reading a row, not by rerunning a build.
  "computation" jsonb,

  "status" text DEFAULT 'CALCULATED' NOT NULL,
  "approved_by" text,
  "approved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "chk_crm_commission_earnings_status"
    CHECK ("status" IN ('CALCULATED', 'APPROVED', 'PAID', 'VOID')),
  CONSTRAINT "chk_crm_commission_earnings_period"
    CHECK ("period_end" >= "period_start"),
  CONSTRAINT "chk_crm_commission_earnings_earned_in_period"
    CHECK ("earned_on" BETWEEN "period_start" AND "period_end")
);

--> statement-breakpoint
-- Recalculating is a no-op, not a second payment. Without this the retry of a
-- request that timed out after its INSERT pays the rep twice, and nothing in
-- the ledger says which of the two rows is the real one.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_earnings_source"
  ON "crm_commission_earnings" ("org_id", "source_type", "source_id", "user_id");

--> statement-breakpoint
-- The attainment read: one earner's period to date, which is an input to every
-- subsequent calculation in that period.
CREATE INDEX IF NOT EXISTS "idx_crm_commission_earnings_attainment"
  ON "crm_commission_earnings" ("org_id", "user_id", "plan_id", "earned_on");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_earnings_status"
  ON "crm_commission_earnings" ("org_id", "status", "earned_on");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_earnings_version"
  ON "crm_commission_earnings" ("org_id", "plan_version_id");

--> statement-breakpoint
-- Seal on the first earning, in the same transaction as the earning itself.
-- `CommissionService.calculateForDeal` also sets `sealed_at` so its own return
-- value is correct without a second round trip; this is what makes the seal true
-- for a writer that is not the service.
CREATE OR REPLACE FUNCTION "crm_commission_seal_version_on_earning"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "crm_commission_plan_versions"
     SET "sealed_at" = now()
   WHERE "plan_version_id" = NEW."plan_version_id"
     AND "org_id" = NEW."org_id"
     AND "sealed_at" IS NULL;
  RETURN NULL;
END;
$$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_crm_commission_earnings_seal_version" ON "crm_commission_earnings";
--> statement-breakpoint
CREATE TRIGGER "trg_crm_commission_earnings_seal_version"
  AFTER INSERT ON "crm_commission_earnings"
  FOR EACH ROW EXECUTE FUNCTION "crm_commission_seal_version_on_earning"();

-- ── Foreign keys ────────────────────────────────────────────────────────────

--> statement-breakpoint
-- Every FK for the four tables, added NOT VALID and then VALIDATEd so that
-- installing them does not hold ACCESS EXCLUSIVE on `organizations` or `users`
-- while it runs.
--
-- Guarded on `pg_constraint` rather than written as bare `ALTER TABLE ... ADD
-- CONSTRAINT`, which is what the rest of this file's `IF NOT EXISTS` buys: this
-- statement takes a lock on a busy table, `lock_timeout` is five seconds, and a
-- migration that dies here must be re-runnable rather than needing somebody to
-- work out by hand which of thirteen constraints already landed.
DO $fks$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT *
    FROM (VALUES
      ('crm_commission_plans',         'fk_crm_commission_plans_org',              'org_id',          'organizations',                'id',              'CASCADE'),
      ('crm_commission_plans',         'fk_crm_commission_plans_created_by',       'created_by',      'users',                        'id',              'SET NULL'),
      ('crm_commission_plan_versions', 'fk_crm_commission_plan_versions_org',      'org_id',          'organizations',                'id',              'CASCADE'),
      ('crm_commission_plan_versions', 'fk_crm_commission_plan_versions_plan',     'plan_id',         'crm_commission_plans',         'plan_id',         'CASCADE'),
      ('crm_commission_plan_versions', 'fk_crm_commission_plan_versions_creator',  'created_by',      'users',                        'id',              'SET NULL'),
      ('crm_commission_assignments',   'fk_crm_commission_assignments_org',        'org_id',          'organizations',                'id',              'CASCADE'),
      ('crm_commission_assignments',   'fk_crm_commission_assignments_plan',       'plan_id',         'crm_commission_plans',         'plan_id',         'CASCADE'),
      ('crm_commission_assignments',   'fk_crm_commission_assignments_user',       'user_id',         'users',                        'id',              'CASCADE'),
      ('crm_commission_earnings',      'fk_crm_commission_earnings_org',           'org_id',          'organizations',                'id',              'CASCADE'),
      -- RESTRICT on the plan and the version: deleting either must not quietly
      -- delete the record of what it paid. Retiring is `plans.retired_on`.
      ('crm_commission_earnings',      'fk_crm_commission_earnings_plan',          'plan_id',         'crm_commission_plans',         'plan_id',         'RESTRICT'),
      ('crm_commission_earnings',      'fk_crm_commission_earnings_version',       'plan_version_id', 'crm_commission_plan_versions', 'plan_version_id', 'RESTRICT'),
      ('crm_commission_earnings',      'fk_crm_commission_earnings_user',          'user_id',         'users',                        'id',              'CASCADE'),
      ('crm_commission_earnings',      'fk_crm_commission_earnings_approved_by',   'approved_by',     'users',                        'id',              'SET NULL')
    ) AS t(child, name, col, parent, parent_col, on_delete)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s NOT VALID',
        fk.child, fk.name, fk.col, fk.parent, fk.parent_col, fk.on_delete);
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.child, fk.name);
  END LOOP;
END
$fks$;

-- ── Tenant isolation ────────────────────────────────────────────────────────

--> statement-breakpoint
-- Without a policy each table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent.
ALTER TABLE "crm_commission_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_plans";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_plans"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_plans" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_plans" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_commission_plan_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_plan_versions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_plan_versions"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_plan_versions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_plan_versions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_commission_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_assignments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_assignments"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_assignments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_assignments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_commission_earnings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_earnings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_earnings"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_earnings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_earnings" TO streamline_app;

-- ── Permissions ─────────────────────────────────────────────────────────────

--> statement-breakpoint
-- Catalogue rows first, for the reason recorded in 0212: `PermissionCatalogSync`
-- runs at boot, AFTER `db:migrate`, so the EXISTS guard below is otherwise false
-- and every grant is silently skipped.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:commission-plans:view', 'crm:commission-plans', 'view',
   'Read commission plans, every dated version of their rules, and which version was in force on a date',
   'crm'),
  ('crm:commission-plans:manage', 'crm:commission-plans', 'manage',
   'Create commission plans, publish a new dated version of their rules, and assign people to them',
   'crm'),
  ('crm:commission-earnings:view', 'crm:commission-earnings', 'view',
   'Read commission earnings and the derivation behind each one',
   'crm'),
  ('crm:commission-earnings:calculate', 'crm:commission-earnings', 'calculate',
   'Compute what a won deal earned under the plan version in force on its close date',
   'crm'),
  ('crm:commission-earnings:approve', 'crm:commission-earnings', 'approve',
   'Approve a calculated commission earning for payment',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- `CRM_MODULE_OWNER` and `CRM_MODULE_ADMIN` -- the slugs `seedSystemRolesForOrg`
-- actually mints. Not `CRM_ADMIN`, which is a `ROLE_TEMPLATES` entry the seeder
-- has never produced and which left eighteen permissions granted to nobody
-- across seven earlier migrations; see `backfill-slugs-exist.spec.ts`.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:commission-plans:view'),
  ('crm:commission-plans:manage'),
  ('crm:commission-earnings:view'),
  ('crm:commission-earnings:calculate'),
  ('crm:commission-earnings:approve')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members get the two view keys and nothing else, matching
-- `buildModuleMemberPermissionKeys`, which grants keys ending `:view` or
-- `:read`. That agreement is the invariant: a backfilled organisation and a
-- newly seeded one must resolve to the same capability, or a tenant's
-- permissions depend on when they signed up.
--
-- Plans at 'all' -- a plan is a scheme document and a rep should be able to read
-- the bands they are measured against. Earnings at 'own', because an earning is
-- somebody's pay. `MODULE_MEMBER_KEY_SCOPE_OVERRIDE` in `seed-system-roles.ts`
-- carries the same 'own' for newly seeded organisations; the two must agree or
-- the tenants who signed up later are the ones leaking salaries.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:commission-plans:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:commission-plans:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:commission-earnings:view', 'own'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:commission-earnings:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- ORG_ADMIN holds ALL_PERMISSION_NAMES at seed time, so an organisation created
-- after this ships gets these five automatically. This closes the gap for the
-- ones created before. There is no 'OWNER' row to grant to: `access.service.ts`
-- returns scope 'all' for `isOrgOwner` before any grant is consulted.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:commission-plans:view'),
  ('crm:commission-plans:manage'),
  ('crm:commission-earnings:view'),
  ('crm:commission-earnings:calculate'),
  ('crm:commission-earnings:approve')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'ORG_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at
-- once; a role that gained a key and a cache that has not heard about it is a
-- 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ORG_ADMIN', 'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'CRM_MODULE_MEMBER')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();

--> statement-breakpoint
ANALYZE "crm_commission_plans";
--> statement-breakpoint
ANALYZE "crm_commission_plan_versions";
--> statement-breakpoint
ANALYZE "crm_commission_assignments";
--> statement-breakpoint
ANALYZE "crm_commission_earnings";
