-- 0957_ar02_drop_workflow_single_fks DOWN
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE workflow_versions
  ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk"
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_versions
  ADD CONSTRAINT "fk_workflow_versions_workflow_id_org"
  FOREIGN KEY (org_id, workflow_id) REFERENCES workflows (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_executions
  ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk"
  FOREIGN KEY (workflow_id) REFERENCES workflows (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_executions
  ADD CONSTRAINT "workflow_executions_workflow_version_id_workflow_versions_id_fk"
  FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_execution_steps
  ADD CONSTRAINT "workflow_execution_steps_execution_id_workflow_executions_id_fk"
  FOREIGN KEY (execution_id) REFERENCES workflow_executions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_approvals
  ADD CONSTRAINT "workflow_approvals_execution_id_workflow_executions_id_fk"
  FOREIGN KEY (execution_id) REFERENCES workflow_executions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_approvals
  ADD CONSTRAINT "workflow_approvals_step_id_workflow_execution_steps_id_fk"
  FOREIGN KEY (step_id) REFERENCES workflow_execution_steps (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_schedules
  ADD CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk"
  FOREIGN KEY (workflow_id) REFERENCES workflows (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_variables
  ADD CONSTRAINT "workflow_variables_workflow_version_id_workflow_versions_id_fk"
  FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_variables
  ADD CONSTRAINT "fk_workflow_variables_workflow_version_id_org"
  FOREIGN KEY (org_id, workflow_version_id) REFERENCES workflow_versions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_audit_logs
  ADD CONSTRAINT "workflow_audit_logs_workflow_id_workflows_id_fk"
  FOREIGN KEY (workflow_id) REFERENCES workflows (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE workflow_audit_logs
  ADD CONSTRAINT "workflow_audit_logs_execution_id_workflow_executions_id_fk"
  FOREIGN KEY (execution_id) REFERENCES workflow_executions (id)
  NOT VALID;
