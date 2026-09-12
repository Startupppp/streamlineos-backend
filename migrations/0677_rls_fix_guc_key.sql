SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_export_jobs;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_export_jobs
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON inv_compliance_documents;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON inv_compliance_documents
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
