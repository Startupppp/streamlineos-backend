SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_created_id"
  ON "audit_logs" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "org_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_target_created_id"
  ON "audit_logs" ("org_id", "target_id", "target_type", "created_at" DESC, "id" DESC)
  WHERE "org_id" IS NOT NULL AND "target_id" IS NOT NULL;
