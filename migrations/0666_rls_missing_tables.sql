SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE expense_export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_export_jobs
  USING (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE inv_compliance_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON inv_compliance_documents
  USING (org_id = current_setting('app.current_org_id', true));
