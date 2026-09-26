-- 1231 — HRM-15: `hr_reporting_manager_policies`, one row per organisation
--
-- The organisation's Reporting Manager Policy (PRD D2): how many secondary managers an employee
-- may have (0–3), which member is the default primary manager when onboarding omits one, the
-- order the default and the uploading administrator are tried in, how many primary-manager changes
-- in a rolling 24 hours pass before a reason and elevated authority are required, and whether a
-- top-level role may exist without a manager.
--
-- Absence of a row means "defaults": ReportingManagerPolicyService reads a missing row as the
-- column defaults below, so no backfill is needed and no organisation is configured by accident.
--
-- The default manager is referenced through `organization_members (org_id, user_id)` rather than
-- `users (id)`, so a default can never name a member of another tenant, and removing the member
-- clears the default instead of leaving a dangling id.
--
-- Rollback: migrations/rollback/1231_hr_reporting_manager_policies.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '1231 precondition: public.organizations is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.organization_members'::regclass AND conname = 'uniq_org_members_org_user'
  ) THEN
    RAISE EXCEPTION '1231 precondition: uniq_org_members_org_user is absent — the default-manager FK has no target';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_reporting_manager_policies" (
  "org_id" text NOT NULL,
  "max_secondary_managers_per_employee" smallint NOT NULL DEFAULT 0,
  "default_primary_manager_user_id" text,
  "fallback_order" text NOT NULL DEFAULT 'CONFIGURED_MANAGER_THEN_UPLOADER',
  "require_reason_after_changes" smallint NOT NULL DEFAULT 3,
  "allow_top_level_without_manager" boolean NOT NULL DEFAULT true,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pk_hr_reporting_manager_policies" PRIMARY KEY ("org_id"),
  CONSTRAINT "chk_hr_rm_policies_max_secondary" CHECK ("max_secondary_managers_per_employee" BETWEEN 0 AND 3),
  CONSTRAINT "chk_hr_rm_policies_fallback_order" CHECK (
    "fallback_order" IN ('CONFIGURED_MANAGER_THEN_UPLOADER', 'UPLOADER_THEN_CONFIGURED_MANAGER')
  ),
  CONSTRAINT "chk_hr_rm_policies_reason_after" CHECK ("require_reason_after_changes" BETWEEN 1 AND 10),
  CONSTRAINT "chk_hr_rm_policies_version" CHECK ("version" >= 1)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_rm_policies_default_manager"
  ON "public"."hr_reporting_manager_policies" ("org_id", "default_primary_manager_user_id")
  WHERE "default_primary_manager_user_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_policies" DROP CONSTRAINT IF EXISTS "fk_hr_rm_policies_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_policies" ADD CONSTRAINT "fk_hr_rm_policies_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_policies" VALIDATE CONSTRAINT "fk_hr_rm_policies_org";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_policies" DROP CONSTRAINT IF EXISTS "fk_hr_rm_policies_default_manager";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_policies" ADD CONSTRAINT "fk_hr_rm_policies_default_manager"
  FOREIGN KEY ("org_id", "default_primary_manager_user_id")
  REFERENCES "public"."organization_members" ("org_id", "user_id")
  ON DELETE SET NULL ("default_primary_manager_user_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_policies" VALIDATE CONSTRAINT "fk_hr_rm_policies_default_manager";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_reporting_manager_policies";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_reporting_manager_policies"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_reporting_manager_policies" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hr_reporting_manager_policies' AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1231 postcondition: RLS policy tenant_isolation is absent on hr_reporting_manager_policies';
  END IF;
END $$;
