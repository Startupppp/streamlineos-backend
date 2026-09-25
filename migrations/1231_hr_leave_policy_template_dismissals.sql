-- 1231 — HR: hr_leave_policy_template_dismissals.
--
-- Ticket 08. A newly created organisation opens Leave Policies with nothing in
-- it, so the product offers Casual Leave, Sick Leave and Comp Off as a starting
-- point. "Not now" must dismiss that offer permanently FOR THE ORGANISATION —
-- not for the browser that clicked it, and not until the next reload — so the
-- refusal is a row, not client storage.
--
-- One row per organisation, so the refusal is idempotent by construction: a
-- second "Not now" from another administrator updates the same row rather than
-- accumulating history nobody reads. org_id is the primary key for that reason.
--
-- dismissed_by is the membership, not the user id: membership is what ties a
-- person to this organisation, and it is what survives the person leaving
-- another one. ON DELETE SET NULL keeps the organisation's refusal when the
-- administrator who made it is removed — the decision was the organisation's.
--
-- Rollback: migrations/rollback/1231_hr_leave_policy_template_dismissals.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '1231 precondition: public.organizations is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_org_members_org_id_key') THEN
    RAISE EXCEPTION '1231 precondition: uniq_org_members_org_id_key is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_leave_policy_template_dismissals" (
  "org_id" text PRIMARY KEY NOT NULL,
  "dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dismissed_by_membership_id" integer
);
--> statement-breakpoint

ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  DROP CONSTRAINT IF EXISTS "hr_leave_policy_template_dismissals_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  ADD CONSTRAINT "hr_leave_policy_template_dismissals_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  VALIDATE CONSTRAINT "hr_leave_policy_template_dismissals_org_id_organizations_id_fk";
--> statement-breakpoint

-- Composite, and SET NULL names the one column it nulls: a bare SET NULL on
-- (org_id, membership) would null the tenant too and abort.
ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  DROP CONSTRAINT IF EXISTS "fk_hr_leave_policy_template_dismissals_org_membership";
--> statement-breakpoint
ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  ADD CONSTRAINT "fk_hr_leave_policy_template_dismissals_org_membership"
  FOREIGN KEY ("org_id", "dismissed_by_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("dismissed_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_leave_policy_template_dismissals"
  VALIDATE CONSTRAINT "fk_hr_leave_policy_template_dismissals_org_membership";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_leave_policy_template_dismissals_org_membership"
  ON "public"."hr_leave_policy_template_dismissals" ("org_id", "dismissed_by_membership_id");
--> statement-breakpoint

ALTER TABLE "public"."hr_leave_policy_template_dismissals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_leave_policy_template_dismissals";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_leave_policy_template_dismissals"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_leave_policy_template_dismissals" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.hr_leave_policy_template_dismissals') IS NULL THEN
    RAISE EXCEPTION '1231 postcondition: hr_leave_policy_template_dismissals was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hr_leave_policy_template_dismissals'
      AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1231 postcondition: tenant_isolation policy is absent — one organisation would read another organisation''s refusal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'hr_leave_policy_template_dismissals'
      AND grantee = 'streamline_app' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION '1231 postcondition: streamline_app holds no SELECT — every read would fail 42501';
  END IF;
END $$;
--> statement-breakpoint
