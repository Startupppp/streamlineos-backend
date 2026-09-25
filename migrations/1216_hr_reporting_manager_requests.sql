-- 1216 — HRM-15: `hr_reporting_manager_requests`, employee-filed "my manager is wrong" requests
--
-- An employee's correction request (PRD §7.5, §8.3) is a lifecycle record, not an edit: HR reviews
-- it and, on approval, ReportingRelationshipService writes the line and stamps `resolved_line_id`.
-- `uniq_hr_rm_requests_active` holds at most one open request per employee per current line, so a
-- double-submit is a 23505 the service turns into REQUEST_DUPLICATE_ACTIVE.
--
-- Line references are SET NULL on delete rather than CASCADE: a same-day correction moves the line
-- it replaced into `hr_reporting_lines_superseded` (1218), and the request must outlive that.
--
-- Rollback: migrations/rollback/1216_hr_reporting_manager_requests.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hr_reporting_lines'::regclass AND conname = 'uniq_hr_reporting_lines_org_id'
  ) THEN
    RAISE EXCEPTION '1216 precondition: uniq_hr_reporting_lines_org_id is absent — the line FKs have no target';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_reporting_manager_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "employee_employment_id" integer NOT NULL,
  "requested_by_user_id" text NOT NULL,
  "current_primary_line_id" integer,
  "suggested_manager_employment_id" integer,
  "requested_effective_from" date,
  "employee_reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "reviewer_user_id" text,
  "review_reason" text,
  "resolved_line_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "pk_hr_reporting_manager_requests" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_hr_rm_requests_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_hr_rm_requests_status" CHECK (
    "status" IN ('PENDING', 'MORE_INFO_REQUIRED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')
  ),
  CONSTRAINT "chk_hr_rm_requests_employee_reason" CHECK (char_length(btrim("employee_reason")) BETWEEN 20 AND 1000),
  CONSTRAINT "chk_hr_rm_requests_review_reason" CHECK ("review_reason" IS NULL OR char_length("review_reason") <= 1000)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_rm_requests_active"
  ON "public"."hr_reporting_manager_requests" ("org_id", "employee_employment_id", (coalesce("current_primary_line_id", 0)))
  WHERE "status" IN ('PENDING', 'MORE_INFO_REQUIRED') AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_org_status"
  ON "public"."hr_reporting_manager_requests" ("org_id", "status", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_org_requester"
  ON "public"."hr_reporting_manager_requests" ("org_id", "requested_by_user_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_employee"
  ON "public"."hr_reporting_manager_requests" ("org_id", "employee_employment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_current_line"
  ON "public"."hr_reporting_manager_requests" ("org_id", "current_primary_line_id")
  WHERE "current_primary_line_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_suggested_manager"
  ON "public"."hr_reporting_manager_requests" ("org_id", "suggested_manager_employment_id")
  WHERE "suggested_manager_employment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rm_requests_resolved_line"
  ON "public"."hr_reporting_manager_requests" ("org_id", "resolved_line_id")
  WHERE "resolved_line_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" DROP CONSTRAINT IF EXISTS "fk_hr_rm_requests_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" ADD CONSTRAINT "fk_hr_rm_requests_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" VALIDATE CONSTRAINT "fk_hr_rm_requests_org";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" DROP CONSTRAINT IF EXISTS "fk_hr_rm_requests_employee";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" ADD CONSTRAINT "fk_hr_rm_requests_employee"
  FOREIGN KEY ("org_id", "employee_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" VALIDATE CONSTRAINT "fk_hr_rm_requests_employee";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" DROP CONSTRAINT IF EXISTS "fk_hr_rm_requests_suggested_manager";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" ADD CONSTRAINT "fk_hr_rm_requests_suggested_manager"
  FOREIGN KEY ("org_id", "suggested_manager_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE SET NULL ("suggested_manager_employment_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" VALIDATE CONSTRAINT "fk_hr_rm_requests_suggested_manager";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" DROP CONSTRAINT IF EXISTS "fk_hr_rm_requests_current_line";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" ADD CONSTRAINT "fk_hr_rm_requests_current_line"
  FOREIGN KEY ("org_id", "current_primary_line_id") REFERENCES "public"."hr_reporting_lines" ("org_id", "id")
  ON DELETE SET NULL ("current_primary_line_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" VALIDATE CONSTRAINT "fk_hr_rm_requests_current_line";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" DROP CONSTRAINT IF EXISTS "fk_hr_rm_requests_resolved_line";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" ADD CONSTRAINT "fk_hr_rm_requests_resolved_line"
  FOREIGN KEY ("org_id", "resolved_line_id") REFERENCES "public"."hr_reporting_lines" ("org_id", "id")
  ON DELETE SET NULL ("resolved_line_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_manager_requests" VALIDATE CONSTRAINT "fk_hr_rm_requests_resolved_line";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_manager_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_reporting_manager_requests";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_reporting_manager_requests"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_reporting_manager_requests" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hr_reporting_manager_requests' AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1216 postcondition: RLS policy tenant_isolation is absent on hr_reporting_manager_requests';
  END IF;
END $$;
