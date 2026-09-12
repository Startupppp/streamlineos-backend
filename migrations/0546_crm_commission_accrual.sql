-- Custom SQL migration file, put your code below! --

-- The commission decomposition ledger, and the constraint that makes
-- "decomposes exactly" a fact about the database rather than a claim in a test.
--
-- Phase 5 ticket 05. Commission is supposed to accrue continuously and every
-- accrued figure is supposed to break down to the deals, the plan version and
-- the rule that produced each part -- with the parts summing to the total
-- exactly, these being integer minor units.
--
-- 0545 already stores a slice-by-slice trace in `crm_commission_earnings.
-- computation`. It cannot do this job, for two reasons that are worth stating
-- because they look like details and are not:
--
--  1. It is a jsonb blob. "Which deals produced this month's accrual, and under
--     which band?" is a scan and a re-parse rather than a query, which is fine
--     for a dispute once a quarter and not fine for a figure a rep is meant to
--     open daily.
--
--  2. Its slice amounts DO NOT SUM to the earning they belong to. Each slice is
--     rounded independently while the total is rounded once from the exact sum,
--     so sum-of-rounded misses rounded-of-sum; and `capMinor` reduces the total
--     while leaving every slice untouched, so a capped earning's slices can
--     overshoot the money owed by orders of magnitude. Measured against the
--     evaluator over twenty thousand random rule sets, roughly a quarter of
--     evaluations disagree by at least one minor unit. This is the normal case,
--     not an edge.
--
-- `crm_commission_accrual_parts` is the same derivation apportioned so that it
-- adds up: the earning's settled total is split across its bands by largest
-- remainder, which also has the effect of attributing a cap to the bands that
-- earned it instead of leaving it dangling. `crm_commission_accrual_snapshots`
-- records what the accrued figure stood at on each day, so that yesterday's
-- number is still what it was yesterday after a late deal lands.
--
-- Three decisions are encoded below.
--
--  1. `trg_crm_commission_accrual_parts_reconcile` is a DEFERRABLE INITIALLY
--     DEFERRED constraint trigger. Deferred because the parts of one earning are
--     inserted as several rows and the invariant is only true once they all are;
--     a constraint trigger because the alternative -- checking in the service --
--     is a rule that holds only for writers who went through the service, and
--     this is a ledger a backfill or a psql session will eventually touch.
--
--  2. Every part carries the deal, the version and the period denormalised. That
--     redundancy is the point: the accrual read is "everything behind this
--     person's number this month", and a four-table join would put it on the
--     slow path of the one screen this ticket exists to make people watch.
--
--  3. Money is `bigint` minor units end to end. No `numeric`, no stored rate as
--     a fraction; rates are integer basis points, copied from the rule document.
--
-- Authored by hand from the Drizzle declarations in
-- `src/db/schema/crm/commission.ts`, column for column: `drizzle-kit generate`
-- is unusable in this repository (see 0205).

SET lock_timeout = '5s';

-- ── Parts: the decomposition ────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_accrual_parts" (
  "part_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "earning_id" text NOT NULL,

  -- Denormalised from the earning. Copied at insert from a row whose own values
  -- never change, and replaced wholesale by a rebuild rather than patched, so
  -- there is no path by which these drift from their source.
  "user_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "plan_version_id" text NOT NULL,
  "earned_on" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,

  -- The deal. This pair is what "decomposes to the deals" means.
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,

  -- Dense from 0 within an earning; the ledger's stable sort key.
  "part_index" integer NOT NULL,

  -- Which rule paid this part. `tier_index` and not the rate alone: two bands of
  -- one plan may share a rate -- 10% to quota, 15% to 150%, 10% beyond is a real
  -- shape -- and attributing by rate would credit the third band's money to the
  -- first.
  "tier_index" integer NOT NULL,
  "tier_from" bigint NOT NULL,
  "rate_bps" integer NOT NULL,
  "multiplier_bps" integer NOT NULL,

  -- The cumulative window of the earner's period basis this band consumed.
  "slice_from_minor" bigint NOT NULL,
  "slice_to_minor" bigint NOT NULL,
  "basis_minor" bigint NOT NULL,

  -- This part's exact share of the earning, apportioned from the settled total
  -- rather than recomputed from the rate.
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "chk_crm_commission_accrual_parts_index"
    CHECK ("part_index" >= 0 AND "tier_index" >= 0),
  CONSTRAINT "chk_crm_commission_accrual_parts_rate"
    CHECK ("rate_bps" >= 0 AND "multiplier_bps" > 0),
  -- A slice runs forward and its basis is the width it covers. A part that
  -- disagreed with its own geometry would decompose to a picture of a band that
  -- was never walked.
  CONSTRAINT "chk_crm_commission_accrual_parts_slice"
    CHECK ("slice_to_minor" >= "slice_from_minor"
           AND "basis_minor" = "slice_to_minor" - "slice_from_minor"),
  CONSTRAINT "chk_crm_commission_accrual_parts_period"
    CHECK ("period_end" >= "period_start"
           AND "earned_on" BETWEEN "period_start" AND "period_end")
);

--> statement-breakpoint
-- A part is identified by its earning and its position; a rebuild replaces the
-- set rather than inserting a second one beside it.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_accrual_parts_slot"
  ON "crm_commission_accrual_parts" ("org_id", "earning_id", "part_index");

--> statement-breakpoint
-- The accrual read: one earner's period to date, decomposed.
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_parts_period"
  ON "crm_commission_accrual_parts" ("org_id", "user_id", "period_start", "earned_on");

--> statement-breakpoint
-- "What did this deal pay, and to whom?" -- the dispute's opening question.
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_parts_source"
  ON "crm_commission_accrual_parts" ("org_id", "source_type", "source_id");

--> statement-breakpoint
-- "What has this version of the plan cost, band by band?" -- the plan author's.
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_parts_version"
  ON "crm_commission_accrual_parts" ("org_id", "plan_version_id", "tier_index");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_parts_earning"
  ON "crm_commission_accrual_parts" ("org_id", "earning_id");

-- ── The invariant, as a constraint ──────────────────────────────────────────

--> statement-breakpoint
-- The parts of an earning sum to that earning's `amount_minor`. Exactly: these
-- are integer minor units, so a residue of one is a residue.
--
-- DEFERRABLE INITIALLY DEFERRED because the parts arrive as several rows and the
-- invariant is only true once the last one has landed; checking per statement
-- would reject the first INSERT of every correct decomposition.
--
-- A constraint trigger rather than a service-side assertion because the service
-- already asserts it, and an assertion in a service is a rule that holds for
-- writers who went through the service. This is a ledger that a backfill, a
-- future source type, or a psql session at 2am will eventually write to, and the
-- failure it prevents is silent: a decomposition that does not add up looks
-- entirely normal on the row and only shows up when somebody totals a column and
-- finds it disagrees with the payslip they are holding.
--
-- An earning with zero parts is permitted. Earnings written by 0545 predate this
-- table and must not be made unreadable by it; `POST /crm/commission/accrual/
-- rebuild` is what supplies their decomposition.
CREATE OR REPLACE FUNCTION "crm_commission_accrual_parts_reconcile"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_org text;
  target_earning text;
  parts_total bigint;
  earning_total bigint;
  parts_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_org := OLD."org_id";
    target_earning := OLD."earning_id";
  ELSE
    target_org := NEW."org_id";
    target_earning := NEW."earning_id";
  END IF;

  SELECT coalesce(sum(p."amount_minor"), 0), count(*)
    INTO parts_total, parts_count
    FROM "crm_commission_accrual_parts" p
   WHERE p."org_id" = target_org
     AND p."earning_id" = target_earning;

  -- Nothing left to reconcile: a rebuild that removed a decomposition, or an
  -- earning that has not been decomposed yet.
  IF parts_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT e."amount_minor"
    INTO earning_total
    FROM "crm_commission_earnings" e
   WHERE e."org_id" = target_org
     AND e."earning_id" = target_earning;

  -- The earning went away in this same transaction; the FK cascade is removing
  -- these rows too and there is nothing to check against.
  IF earning_total IS NULL THEN
    RETURN NULL;
  END IF;

  IF parts_total <> earning_total THEN
    RAISE EXCEPTION
      'commission accrual parts for earning % sum to % but the earning is %; a decomposition must reconstruct its total exactly',
      target_earning, parts_total, earning_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_crm_commission_accrual_parts_reconcile"
  ON "crm_commission_accrual_parts";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_crm_commission_accrual_parts_reconcile"
  AFTER INSERT OR UPDATE OR DELETE ON "crm_commission_accrual_parts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "crm_commission_accrual_parts_reconcile"();

-- ── Snapshots: the curve people watch ───────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_commission_accrual_snapshots" (
  "snapshot_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,

  -- The day this figure was true of. The curve's x axis.
  "as_of_date" date NOT NULL,

  "accrued_minor" bigint NOT NULL,
  "basis_minor" bigint NOT NULL,
  "earning_count" integer DEFAULT 0 NOT NULL,
  "part_count" integer DEFAULT 0 NOT NULL,

  -- Attainment at the close of the latest earning counted here, taken from that
  -- earning rather than recomputed: the quota that produced it lives on an
  -- assignment that can since have been re-dated or ended, and a curve point
  -- that silently re-bases itself against today's quota is the restatement this
  -- table exists to prevent.
  "attainment_bps" integer,
  "currency" text NOT NULL,
  "computed_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "chk_crm_commission_accrual_snapshots_period"
    CHECK ("period_end" >= "period_start"
           AND "as_of_date" BETWEEN "period_start" AND "period_end"),
  CONSTRAINT "chk_crm_commission_accrual_snapshots_counts"
    CHECK ("earning_count" >= 0 AND "part_count" >= 0)
);

--> statement-breakpoint
-- One point per day; the day's later writes update it in place, so the curve is
-- end-of-day rather than every intraday flicker.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_commission_accrual_snapshots_day"
  ON "crm_commission_accrual_snapshots"
     ("org_id", "user_id", "plan_id", "period_start", "as_of_date");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_snapshots_curve"
  ON "crm_commission_accrual_snapshots" ("org_id", "user_id", "as_of_date");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_commission_accrual_snapshots_plan"
  ON "crm_commission_accrual_snapshots" ("org_id", "plan_id", "period_start");

-- ── Foreign keys ────────────────────────────────────────────────────────────

--> statement-breakpoint
-- Added NOT VALID then VALIDATEd so installing them does not hold ACCESS
-- EXCLUSIVE on `organizations` or `users` while it runs. Guarded on
-- `pg_constraint` so a run that dies on the five-second `lock_timeout` is
-- re-runnable rather than needing somebody to work out by hand which of these
-- already landed.
DO $fks$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT *
    FROM (VALUES
      -- CASCADE from the earning: a decomposition has no meaning without the
      -- earning it decomposes, and an orphaned part would still sum into every
      -- period total.
      ('crm_commission_accrual_parts',     'fk_crm_commission_accrual_parts_earning',   'earning_id',      'crm_commission_earnings',      'earning_id',      'CASCADE'),
      ('crm_commission_accrual_parts',     'fk_crm_commission_accrual_parts_org',       'org_id',          'organizations',                'id',              'CASCADE'),
      ('crm_commission_accrual_parts',     'fk_crm_commission_accrual_parts_user',      'user_id',         'users',                        'id',              'CASCADE'),
      -- RESTRICT on the plan and the version, matching the earning: deleting
      -- either must not quietly delete the record of what it paid.
      ('crm_commission_accrual_parts',     'fk_crm_commission_accrual_parts_plan',      'plan_id',         'crm_commission_plans',         'plan_id',         'RESTRICT'),
      ('crm_commission_accrual_parts',     'fk_crm_commission_accrual_parts_version',   'plan_version_id', 'crm_commission_plan_versions', 'plan_version_id', 'RESTRICT'),
      ('crm_commission_accrual_snapshots', 'fk_crm_commission_accrual_snapshots_org',   'org_id',          'organizations',                'id',              'CASCADE'),
      ('crm_commission_accrual_snapshots', 'fk_crm_commission_accrual_snapshots_user',  'user_id',         'users',                        'id',              'CASCADE'),
      ('crm_commission_accrual_snapshots', 'fk_crm_commission_accrual_snapshots_plan',  'plan_id',         'crm_commission_plans',         'plan_id',         'RESTRICT')
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
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. These two
-- carry compensation, so silent is the worst way for it to be wrong.
ALTER TABLE "crm_commission_accrual_parts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_accrual_parts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_accrual_parts"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_accrual_parts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_accrual_parts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_commission_accrual_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_commission_accrual_snapshots";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_commission_accrual_snapshots"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_commission_accrual_snapshots" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_commission_accrual_snapshots" TO streamline_app;

-- ── Permissions ─────────────────────────────────────────────────────────────

--> statement-breakpoint
-- Catalogue row first, for the reason recorded in 0212: `PermissionCatalogSync`
-- runs at boot, AFTER `db:migrate`, so the EXISTS guard on every grant below is
-- otherwise false and the whole backfill is skipped in silence.
--
-- Only one new key. The four accrual READ routes are gated on
-- `crm:commission-earnings:view`, which 0545 already catalogued and granted: an
-- accrual is a set of earnings summed, so a key that granted the total while
-- withholding the parts would be permission to see a figure nobody could check.
-- Reusing it also inherits its scoping -- already `scopable`, already `own` for
-- CRM members -- instead of introducing a second scope rule that would have to
-- be kept in step with the first.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:commission-accruals:rebuild', 'crm:commission-accruals', 'rebuild',
   'Re-derive the stored decomposition of commission earnings over a date range, without changing any amount',
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
  ('crm:commission-accruals:rebuild')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- ORG_ADMIN holds ALL_PERMISSION_NAMES at seed time, so an organisation created
-- after this ships gets the key automatically. This closes the gap for the ones
-- created before. There is no 'OWNER' row to grant to: `access.service.ts`
-- returns scope 'all' for `isOrgOwner` before any grant is consulted.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:commission-accruals:rebuild', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'ORG_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:commission-accruals:rebuild')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- No CRM_MODULE_MEMBER grant, and that is deliberate rather than an omission.
-- `buildModuleMemberPermissionKeys` gives members a module's keys ending `:view`
-- or `:read`; this one ends `:rebuild`, so a newly seeded organisation does not
-- give it to members either. A backfilled organisation and a new one therefore
-- resolve to the same capability, which is the invariant migration 0226 exists
-- because somebody broke.

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at
-- once; a role that gained a key and a cache that has not heard about it is a
-- 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ORG_ADMIN', 'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();

--> statement-breakpoint
ANALYZE "crm_commission_accrual_parts";
--> statement-breakpoint
ANALYZE "crm_commission_accrual_snapshots";
