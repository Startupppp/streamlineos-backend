-- 1219 — HRM-15: `hr_top_level_roles`, the explicit "reports to nobody" exception
--
-- A top-level employee has no primary manager only by an explicit, reasoned, effective-dated record
-- (PRD D3). Until now that decision was stored nowhere but the metadata of the
-- `hr.employee_onboarded` audit row, so coverage reported every founder and CEO as "missing a
-- manager". One open row per employee (`uniq_hr_top_level_roles_open`); ending a role closes it,
-- nothing is deleted.
--
-- Backfill: every `hr.employee_onboarded` audit row with `metadata.topLevelRole = true` whose
-- employee still has no current primary line becomes an open top-level role from the joining date
-- (or the audit date), carrying the recorded reason. An employee who has since been given a manager
-- is not backfilled — the later assignment is the truth.
--
-- Rollback: migrations/rollback/1219_hr_top_level_roles.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION '1219 precondition: public.audit_logs is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_top_level_roles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "employment_id" integer NOT NULL,
  "reason" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date NOT NULL DEFAULT 'infinity'::date,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_by" text,
  "ended_at" timestamp with time zone,
  CONSTRAINT "pk_hr_top_level_roles" PRIMARY KEY ("id"),
  CONSTRAINT "chk_hr_top_level_roles_reason" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "chk_hr_top_level_roles_dates" CHECK ("effective_from" <= "effective_to")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_top_level_roles_open"
  ON "public"."hr_top_level_roles" ("org_id", "employment_id")
  WHERE "effective_to" = 'infinity'::date;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_top_level_roles_employment"
  ON "public"."hr_top_level_roles" ("org_id", "employment_id", "effective_from");
--> statement-breakpoint

ALTER TABLE "public"."hr_top_level_roles" DROP CONSTRAINT IF EXISTS "fk_hr_top_level_roles_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_top_level_roles" ADD CONSTRAINT "fk_hr_top_level_roles_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_top_level_roles" VALIDATE CONSTRAINT "fk_hr_top_level_roles_org";
--> statement-breakpoint

ALTER TABLE "public"."hr_top_level_roles" DROP CONSTRAINT IF EXISTS "fk_hr_top_level_roles_employment";
--> statement-breakpoint
ALTER TABLE "public"."hr_top_level_roles" ADD CONSTRAINT "fk_hr_top_level_roles_employment"
  FOREIGN KEY ("org_id", "employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_top_level_roles" VALIDATE CONSTRAINT "fk_hr_top_level_roles_employment";
--> statement-breakpoint

ALTER TABLE "public"."hr_top_level_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_top_level_roles";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_top_level_roles"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_top_level_roles" TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE
  candidates integer;
  backfilled integer;
BEGIN
  SELECT count(*) INTO candidates
  FROM "public"."audit_logs"
  WHERE action = 'hr.employee_onboarded' AND metadata->>'topLevelRole' = 'true';

  INSERT INTO "public"."hr_top_level_roles" (org_id, employment_id, reason, effective_from, created_by, created_at)
  SELECT DISTINCT ON (audit.org_id, employment.id)
    audit.org_id,
    employment.id,
    left(coalesce(nullif(btrim(audit.metadata->>'topLevelRoleReason'), ''), 'Recorded as a top-level role at onboarding'), 500),
    coalesce(employment.joining_date, audit.created_at::date),
    audit.user_id,
    audit.created_at
  FROM "public"."audit_logs" audit
  JOIN "public"."hr_people" person
    ON person.org_id = audit.org_id AND person.user_id = audit.target_id AND person.deleted_at IS NULL
  JOIN "public"."hr_employments" employment
    ON employment.org_id = audit.org_id AND employment.person_id = person.id
   AND employment.is_primary = true AND employment.deleted_at IS NULL
  WHERE audit.action = 'hr.employee_onboarded'
    AND audit.metadata->>'topLevelRole' = 'true'
    AND audit.org_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "public"."hr_reporting_lines" line
      WHERE line.org_id = audit.org_id
        AND line.employment_id = employment.id
        AND line.line_type = 'primary'
        AND line.effective_from <= CURRENT_DATE
        AND line.effective_to >= CURRENT_DATE
    )
  ORDER BY audit.org_id, employment.id, audit.created_at DESC
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS backfilled = ROW_COUNT;

  RAISE NOTICE '1219: % top-level onboarding audit row(s) found; % open top-level role(s) backfilled', candidates, backfilled;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hr_top_level_roles' AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1219 postcondition: RLS policy tenant_isolation is absent on hr_top_level_roles';
  END IF;
END $$;
