SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "hr_document_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_document_tags";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_document_tags"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "onboarding_task_dependencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "onboarding_task_dependencies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_task_dependencies"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "termination_reasons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "termination_reasons";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "termination_reasons"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "termination_supporting_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "termination_supporting_documents";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "termination_supporting_documents"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_disciplinary_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_employee_sensitive_disciplinary_records";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_employee_sensitive_disciplinary_records"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_grievance_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_employee_sensitive_grievance_records";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_employee_sensitive_grievance_records"
  FOR ALL USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "hr_export_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_export_jobs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_export_jobs"
  FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
