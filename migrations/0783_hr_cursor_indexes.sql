-- 0783: Cursor keyset indexes for HR services currently using OFFSET pagination.
--
-- These tables serve list endpoints that still use OFFSET (hr-safety, hr-cases,
-- hr-automation-rules, hr-policies, hr-templates). Under RLS an index that does
-- not lead with org_id is refused; a (org_id, created_at DESC, id DESC) keyset
-- satisfies the tenant qual AND the sort order in a single pass.
--
-- The OFFSET endpoints must be converted to cursor pagination in a follow-up;
-- these indexes are the prerequisite and are safe to create now because the
-- existing ORDER BY clauses already match (org_id filter + created_at DESC sort).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_safety_incidents_org_created_id"
  ON "hr_safety_incidents" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_cases_org_created_id"
  ON "hr_cases" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_automation_rules_org_created_id"
  ON "hr_automation_rules" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_policies_org_created_id"
  ON "hr_policies" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_templates_org_updated_id"
  ON "hr_templates" ("org_id", "updated_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_performance_documents_org_created_id"
  ON "hr_performance_documents" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "is_active" = true;
