import { boolean, foreignKey, index, integer, pgEnum, text, timestamp, unique } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations } from "../common/auth";
import { projects } from "./core";
import { projectAutomations } from "./ticket-integrations";
import { tickets } from "./ticket-core";

/**
 * Phase 5 (Build release closure): durable automation run history.
 *
 * `automation_run_outcome` distinguishes "the rule evaluated and did not match"
 * from "the rule never got a chance to evaluate" (loop guard / rate limit) from
 * "it matched and its actions ran" — three different visibility questions an
 * operator asks when a rule seems to have not fired.
 */
export const automationRunOutcomeEnum = pgEnum("automation_run_outcome", [
  "matched_success",
  "matched_partial_failure",
  "matched_failed",
  "not_matched",
  "blocked_loop_guard",
  "blocked_rate_limit",
  "error",
]);

export const automationActionOutcomeEnum = pgEnum("automation_action_outcome", ["success", "failure"]);

/**
 * One row per automation rule evaluated for one trigger event.
 *
 * `automationId` is nullable: a chain blocked by the loop guard or the rate
 * limit is recorded before any rule is loaded, so there is no specific rule to
 * attribute the row to — the row still exists so the block itself is visible.
 */
export const projectAutomationRuns = build.table(
  "project_automation_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    projectId: integer("project_id").notNull(),
    automationId: integer("automation_id"),
    ticketId: integer("ticket_id"),
    triggerEvent: text("trigger_event").notNull(),
    matched: boolean("matched").notNull(),
    outcome: automationRunOutcomeEnum("outcome").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: "fk_project_automation_runs_org_project",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.automationId],
      foreignColumns: [projectAutomations.orgId, projectAutomations.id],
      name: "fk_project_automation_runs_org_automation",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.orgId, t.ticketId],
      foreignColumns: [tickets.orgId, tickets.id],
      name: "fk_project_automation_runs_org_ticket",
    }).onDelete("set null"),
    index("idx_project_automation_runs_org_project_created").on(t.orgId, t.projectId, t.createdAt),
    index("idx_project_automation_runs_org_automation_created").on(t.orgId, t.automationId, t.createdAt),
    unique("uniq_project_automation_runs_org_id").on(t.orgId, t.id),
  ],
);

/**
 * One row per action executed within a matched run — the per-action
 * success/failure/error-message grain the brief asks for. Normalized per
 * BE-42 rather than a JSONB array on the run row, because it is an
 * independently-countable, independently-failing list.
 */
export const projectAutomationRunActions = build.table(
  "project_automation_run_actions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    runId: integer("run_id").notNull(),
    actionIndex: integer("action_index").notNull(),
    actionType: text("action_type").notNull(),
    outcome: automationActionOutcomeEnum("outcome").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [projectAutomationRuns.orgId, projectAutomationRuns.id],
      name: "fk_project_automation_run_actions_org_run",
    }).onDelete("cascade"),
    index("idx_project_automation_run_actions_run").on(t.runId),
    unique("uniq_project_automation_run_actions_org_id").on(t.orgId, t.id),
  ],
);
