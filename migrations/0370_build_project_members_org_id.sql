SET statement_timeout = 0;

-- =============================================================================
-- 0370 — Build: tenant-scope project_members, plus two index corrections
-- =============================================================================
-- `project_members` carried no `org_id`, so tenancy was a two-hop chain through
-- `projects`. Every query that filtered by `project_id`/`user_id` alone was
-- relying on an upstream check rather than on the row itself — and the table
-- holds `hourly_rate`, which feeds billing. Violates CLAUDE.md §19 and H7.
--
-- Written as expand -> backfill -> contract so it is safe on a populated table:
-- drizzle-kit would emit a single `ADD COLUMN ... NOT NULL`, which aborts when
-- rows already exist.
--
-- Also: drop `idx_tickets_org_project`, a strict prefix duplicate of
-- `idx_tickets_org_project_status` (pure write overhead, no read it can serve
-- that the longer index cannot); and add a trigram index on `projects.name`,
-- which `ProjectsService.list` searches with a leading-wildcard ILIKE and which
-- had no supporting index at all (`tickets.title` already has one).
--
-- Reversal: see 0370_build_project_members_org_id.down.sql
-- =============================================================================

-- --- expand -------------------------------------------------------------------
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "org_id" text;

-- --- backfill -----------------------------------------------------------------
-- Chunked so a large table does not hold one long transaction.
DO $$
DECLARE
  updated integer;
BEGIN
  LOOP
    UPDATE "project_members" pm
       SET "org_id" = p."org_id"
      FROM "projects" p
     WHERE p."id" = pm."project_id"
       AND pm."org_id" IS NULL
       AND pm."id" IN (
         SELECT "id" FROM "project_members" WHERE "org_id" IS NULL LIMIT 10000
       );
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
  END LOOP;
END $$;

-- Any row still NULL is an orphan whose project no longer exists; it can never
-- be tenant-scoped, so fail loudly rather than silently dropping tenancy.
DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "project_members" WHERE "org_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'project_members has % row(s) with no resolvable org_id (orphaned project_id). Resolve before migrating.',
      orphans;
  END IF;
END $$;

-- --- contract -----------------------------------------------------------------
ALTER TABLE "project_members" ALTER COLUMN "org_id" SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_org_id_organizations_id_fk') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "project_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_project_members_org_user"
  ON "project_members" ("org_id", "user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_members_org_id') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "uniq_project_members_org_id" UNIQUE ("org_id", "id");
  END IF;
END $$;

-- --- project_template_tickets: the last Build table without a tenant column ----
ALTER TABLE "project_template_tickets" ADD COLUMN IF NOT EXISTS "org_id" text;
ALTER TABLE "project_template_tickets"
  ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "project_template_tickets"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;

DO $$
DECLARE
  updated integer;
BEGIN
  LOOP
    UPDATE "project_template_tickets" tt
       SET "org_id" = t."org_id"
      FROM "project_templates" t
     WHERE t."id" = tt."template_id"
       AND tt."org_id" IS NULL
       AND tt."id" IN (
         SELECT "id" FROM "project_template_tickets" WHERE "org_id" IS NULL LIMIT 10000
       );
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
  END LOOP;
END $$;

DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "project_template_tickets" WHERE "org_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'project_template_tickets has % row(s) with no resolvable org_id. Resolve before migrating.',
      orphans;
  END IF;
END $$;

ALTER TABLE "project_template_tickets" ALTER COLUMN "org_id" SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_template_tickets_org_id_organizations_id_fk') THEN
    ALTER TABLE "project_template_tickets" ADD CONSTRAINT "project_template_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_project_template_tickets_org_template"
  ON "project_template_tickets" ("org_id", "template_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_template_tickets_org_id') THEN
    ALTER TABLE "project_template_tickets" ADD CONSTRAINT "uniq_project_template_tickets_org_id" UNIQUE ("org_id", "id");
  END IF;
END $$;

-- --- PK capacity: widen the append-only tables to bigint -----------------------
-- serial is int4 (max 2,147,483,647). These four are append-only, never pruned,
-- and the two log tables exhaust int4 in under a year at target scale.
-- Exhaustion is a hard INSERT failure, and repairing it on a billion-row table
-- is far worse than doing it now. Verified: ZERO inbound foreign keys reference
-- any of these ids, so each widening is a single-table operation.
ALTER TABLE "ticket_activity_log"      ALTER COLUMN "id" SET DATA TYPE bigint;
ALTER SEQUENCE "ticket_activity_log_id_seq"      AS bigint;

ALTER TABLE "ticket_comment_mentions"  ALTER COLUMN "id" SET DATA TYPE bigint;
ALTER SEQUENCE "ticket_comment_mentions_id_seq"  AS bigint;

ALTER TABLE "project_daily_snapshots"  ALTER COLUMN "id" SET DATA TYPE bigint;
ALTER SEQUENCE "project_daily_snapshots_id_seq"  AS bigint;

ALTER TABLE "webhook_deliveries"       ALTER COLUMN "id" SET DATA TYPE bigint;
ALTER SEQUENCE "webhook_deliveries_id_seq"       AS bigint;

-- --- money: integer minor units + ISO-4217 -------------------------------------
-- `projects.budget` and `project_members.hourly_rate` were numeric(x,2) with no
-- currency column, and the budget service read them via Number() and did float
-- arithmetic (hours * rate) before summing. Integer minor units remove the drift;
-- currency is backfilled from the owning organization rather than guessed.
--
-- EXPAND only: the original decimal columns are deliberately retained so this
-- migration is reversible and any un-migrated reader keeps working. Dropping
-- them is a separate contract migration once nothing reads them.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "budget_minor" bigint;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "budget_currency" text;

ALTER TABLE "project_members"
  ADD COLUMN IF NOT EXISTS "hourly_rate_minor" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "rate_currency" text;

UPDATE "projects" p
   SET "budget_minor" = round(p."budget" * 100)::bigint
 WHERE p."budget" IS NOT NULL
   AND p."budget_minor" IS NULL;

UPDATE "projects" p
   SET "budget_currency" = o."currency"
  FROM "organizations" o
 WHERE o."id" = p."org_id"
   AND p."budget_currency" IS NULL;

UPDATE "project_members" pm
   SET "hourly_rate_minor" = round(pm."hourly_rate" * 100)::bigint
 WHERE pm."hourly_rate" IS NOT NULL
   AND pm."hourly_rate_minor" = 0;

UPDATE "project_members" pm
   SET "rate_currency" = o."currency"
  FROM "organizations" o
 WHERE o."id" = pm."org_id"
   AND pm."rate_currency" IS NULL;

-- --- index corrections --------------------------------------------------------
DROP INDEX IF EXISTS "idx_tickets_org_project";

CREATE INDEX IF NOT EXISTS "idx_projects_name_trgm"
  ON "projects" USING gin ("name" gin_trgm_ops);
