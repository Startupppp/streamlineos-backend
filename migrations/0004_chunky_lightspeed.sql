CREATE TYPE "public"."workflow_approval_status" AS ENUM('pending', 'approved', 'rejected', 'delegated', 'expired');--> statement-breakpoint
CREATE TYPE "public"."workflow_execution_status" AS ENUM('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."workflow_node_type" AS ENUM('trigger', 'condition', 'approval', 'action', 'delay', 'loop', 'ai_action', 'integration', 'script', 'end');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('draft', 'published', 'disabled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workflow_trigger_type" AS ENUM('event', 'schedule', 'webhook', 'api', 'manual');--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" "workflow_node_type" NOT NULL,
	"action_type" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb,
	"position" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"approver_id" text NOT NULL,
	"status" "workflow_approval_status" DEFAULT 'pending' NOT NULL,
	"comment" text,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"workflow_id" uuid,
	"execution_id" uuid,
	"actor_id" text,
	"event" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" "workflow_node_type" NOT NULL,
	"status" "workflow_execution_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"status" "workflow_execution_status" DEFAULT 'pending' NOT NULL,
	"trigger_type" "workflow_trigger_type",
	"trigger_data" jsonb,
	"context" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"triggered_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"trigger_type" "workflow_trigger_type" NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_type" text NOT NULL,
	"default_value" jsonb,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition_json" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_step_id_workflow_execution_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."workflow_execution_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_secrets" ADD CONSTRAINT "workflow_secrets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_variables" ADD CONSTRAINT "workflow_variables_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_actions_version" ON "workflow_actions" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_approvals_execution" ON "workflow_approvals" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_approvals_approver_status" ON "workflow_approvals" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_org" ON "workflow_audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_workflow" ON "workflow_audit_logs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_org_created" ON "workflow_audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_steps_execution" ON "workflow_execution_steps" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_steps_execution_node" ON "workflow_execution_steps" USING btree ("execution_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org" ON "workflow_executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org_status" ON "workflow_executions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_workflow" ON "workflow_executions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org_created" ON "workflow_executions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_workflow" ON "workflow_schedules" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_org_enabled" ON "workflow_schedules" USING btree ("org_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_next_run" ON "workflow_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_secrets_org" ON "workflow_secrets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_triggers_version" ON "workflow_triggers" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_variables_version" ON "workflow_variables" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_workflow" ON "workflow_versions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_workflow_version" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "idx_workflows_org" ON "workflows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflows_org_status" ON "workflows" USING btree ("org_id","status");