import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { payrollRuns } from "./runs";

export const payrollCommandStatusEnum = pgEnum("payroll_command_status", [
  "IN_FLIGHT",
  "SUCCEEDED",
  "FAILED",
]);

/**
 * Durable command/job receipts for payroll mutations.
 * Used for idempotency (org + command + key) and operator-visible history.
 */
export const payrollCommandReceipts = pgTable(
  "payroll_command_receipts",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "set null" }),
    command: text("command").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: payrollCommandStatusEnum("status").default("IN_FLIGHT").notNull(),
    requestHash: text("request_hash"),
    response: jsonb("response"),
    errorMessage: text("error_message"),
    correlationId: text("correlation_id"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_payroll_cmd_receipts_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_command_receipts_org_cmd_key").on(
      table.orgId,
      table.command,
      table.idempotencyKey,
    ),
    index("idx_payroll_command_receipts_org_run").on(table.orgId, table.runId),
    index("idx_payroll_command_receipts_org_status").on(table.orgId, table.status),
    index("idx_payroll_command_receipts_correlation").on(table.correlationId),
    index("idx_payroll_command_receipts_expires").on(table.expiresAt),
  ],
);

export const payrollSchedulerState = pgTable(
  "payroll_scheduler_state",
  {
    id: serial("id").primaryKey(),
    jobName: text("job_name").notNull(),
    lastStartedAt: timestamp("last_started_at"),
    lastFinishedAt: timestamp("last_finished_at"),
    lastSuccessAt: timestamp("last_success_at"),
    lastError: text("last_error"),
    runCount: integer("run_count").default(0).notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("uniq_payroll_scheduler_state_job").on(table.jobName)],
);
