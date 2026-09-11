-- AR-02: Drop superseded single-column workflow FKs.
-- All 10 composite (org_id, child_id) -> (org_id, id) FKs were added by prior
-- migration work (fk_workflow_*_org naming convention). This migration drops:
--   - 10 single-column FKs that are now superseded by composites
--   - 2 duplicate composite FKs on workflow_variables and workflow_versions
--     (the Drizzle-managed CASCADE composites remain: fk_workflow_variables_org_version,
--      fk_workflow_versions_org_workflow)
-- Constraint names verified against pg_catalog before authoring.

SET lock_timeout = '5s';

-- workflow_versions: drop single-col FK (composite fk_workflow_versions_org_workflow kept)
ALTER TABLE workflow_versions
  DROP CONSTRAINT workflow_versions_workflow_id_workflows_id_fk;

-- drop the no-action duplicate (fk_workflow_versions_org_workflow with CASCADE remains)
ALTER TABLE workflow_versions
  DROP CONSTRAINT fk_workflow_versions_workflow_id_org;

-- workflow_executions: drop both single-col FKs
ALTER TABLE workflow_executions
  DROP CONSTRAINT workflow_executions_workflow_id_workflows_id_fk;
--> statement-breakpoint
ALTER TABLE workflow_executions
  DROP CONSTRAINT workflow_executions_workflow_version_id_workflow_versions_id_fk;

-- workflow_execution_steps: drop single-col FK
ALTER TABLE workflow_execution_steps
  DROP CONSTRAINT workflow_execution_steps_execution_id_workflow_executions_id_fk;

-- workflow_approvals: drop both single-col FKs
ALTER TABLE workflow_approvals
  DROP CONSTRAINT workflow_approvals_execution_id_workflow_executions_id_fk;
--> statement-breakpoint
ALTER TABLE workflow_approvals
  DROP CONSTRAINT workflow_approvals_step_id_workflow_execution_steps_id_fk;

-- workflow_schedules: drop single-col FK
ALTER TABLE workflow_schedules
  DROP CONSTRAINT workflow_schedules_workflow_id_workflows_id_fk;

-- workflow_variables: drop single-col FK (composite fk_workflow_variables_org_version kept)
ALTER TABLE workflow_variables
  DROP CONSTRAINT workflow_variables_workflow_version_id_workflow_versions_id_fk;

-- drop the no-action duplicate (fk_workflow_variables_org_version with CASCADE remains)
ALTER TABLE workflow_variables
  DROP CONSTRAINT fk_workflow_variables_workflow_version_id_org;

-- workflow_audit_logs: drop both single-col FKs
ALTER TABLE workflow_audit_logs
  DROP CONSTRAINT workflow_audit_logs_workflow_id_workflows_id_fk;
--> statement-breakpoint
ALTER TABLE workflow_audit_logs
  DROP CONSTRAINT workflow_audit_logs_execution_id_workflow_executions_id_fk;
