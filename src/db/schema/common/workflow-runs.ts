import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./auth";

/**
 * Durable workflow execution.
 *
 * A run is a workflow that has started and not yet finished. Its steps are
 * recorded as they complete, so a process that dies mid-run resumes from the
 * last completed step rather than repeating work — which for a workflow that
 * sends a customer a message is the difference between resilience and sending
 * it twice.
 *
 * Postgres rather than a queue product: the outbox this drains from is already
 * transactional, and keeping the run in the same database means a step's writes
 * and its own completion record commit together.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    workflowRunId: text("workflow_run_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    workflowName: text("workflow_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),

    /**
     * PENDING claimable · RUNNING leased · SLEEPING waiting for runAfter ·
     * COMPLETED · DEAD_LETTERED retries exhausted · CANCELLED.
     */
    status: text("status").notNull().default("PENDING"),

    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),

    /** Not claimable before this. Carries both retry backoff and step sleeps. */
    runAfter: timestamp("run_after").notNull().defaultNow(),
    /** Held by whichever worker is executing; expiry releases a crashed run. */
    leaseExpiresAt: timestamp("lease_expires_at"),

    output: jsonb("output").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    deadLetteredAt: timestamp("dead_lettered_at"),

    /** Joins the run to the request or event that caused it. */
    correlationId: text("correlation_id"),
    causationEventId: text("causation_event_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    // One run per triggering event, so a redelivered outbox event resumes the
    // existing run instead of starting a second one.
    uniqueIndex("uniq_workflow_runs_causation")
      .on(t.organizationId, t.workflowName, t.causationEventId)
      .where(sql`causation_event_id is not null`),
    index("idx_workflow_runs_claim").on(t.status, t.runAfter, t.leaseExpiresAt),
    index("idx_workflow_runs_org_status").on(t.organizationId, t.status, t.createdAt),
  ],
);

/**
 * A completed step's recorded outcome.
 *
 * Presence is the memo: a step whose row exists is never executed again, its
 * recorded output is returned instead. That is what makes a resumed run skip
 * the work it already did.
 */
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    workflowStepId: bigint("workflow_step_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    workflowRunId: text("workflow_run_id").notNull(),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    stepName: text("step_name").notNull(),
    /** COMPLETED or FAILED. A failed step is kept for inspection, not replayed. */
    status: text("status").notNull().default("COMPLETED"),
    output: jsonb("output"),
    error: text("error"),
    attempt: integer("attempt").notNull().default(0),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    uniqueIndex("uniq_workflow_steps_run_name").on(
      t.organizationId,
      t.workflowRunId,
      t.stepName,
    ),
    index("idx_workflow_steps_run").on(t.organizationId, t.workflowRunId, t.startedAt),
  ],
);
