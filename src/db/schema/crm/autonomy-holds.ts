import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * The interval in which a decision can still be stopped.
 *
 * Everything else the system does is instantly reversible, so a mistake costs a
 * click. A message to a customer is not: once it has left, the only remedy is a
 * second message apologising for the first.
 *
 * Nobody clicks approve — they only ever click cancel. That is the whole design.
 * An approval queue that nobody empties stops the product; a hold that nobody
 * reads still sends.
 */

export const HOLD_STATUSES = ["held", "sent", "cancelled", "failed"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const autonomyHolds = pgTable(
  "autonomy_holds",
  {
    autonomyHoldId: text("autonomy_hold_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    autonomousDecisionId: text("autonomous_decision_id").notNull(),

    kind: text("kind").$type<"quote.sent">().notNull(),
    /**
     * The concurrency control, not a label.
     *
     * The send path moves `held -> sent` conditionally and checks the affected
     * row, so a cancel landing in the same instant as the window expiring
     * resolves one way or the other and never both.
     */
    status: text("status").$type<HoldStatus>().default("held").notNull(),

    /** An exclusive arc. A second holdable thing gets its own column. */
    quoteId: integer("quote_id"),

    holdUntil: timestamp("hold_until").notNull(),
    /** So an operator can find the run that is waiting. */
    workflowRunId: text("workflow_run_id"),

    sentAt: timestamp("sent_at"),
    cancelledAt: timestamp("cancelled_at"),
    /** No FK to users — see migration 0223. */
    cancelledByUserId: text("cancelled_by_user_id"),
    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One live hold per quote: two would race to send the same document.
    uniqueIndex("uniq_autonomy_holds_live_quote")
      .on(t.organizationId, t.quoteId)
      .where(sql`${t.status} = 'held'`),
    index("idx_autonomy_holds_live")
      .on(t.organizationId, t.holdUntil)
      .where(sql`${t.status} = 'held'`),
    index("idx_autonomy_holds_decision").on(t.organizationId, t.autonomousDecisionId),
  ],
);
