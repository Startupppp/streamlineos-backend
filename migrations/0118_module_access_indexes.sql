SET statement_timeout = 0;
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_role_assignments_org_role"
  ON "role_assignments" USING btree ("org_id", "role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_module_created"
  ON "audit_logs" USING btree ("org_id", (metadata->>'moduleKey'), "created_at" DESC);