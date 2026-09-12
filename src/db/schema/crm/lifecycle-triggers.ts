import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  date,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/* ────────────────────────────────────────────────────────────────────────────
 * Renewal and churn triggers: what made the existing loop look at a customer.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a customer was put in front of the outbound loop.
 *
 * Three reasons, one machine. `renewal-due` is the calendar: the term comes up
 * inside the lead window and the conversation opens on schedule. `churn-risk` is
 * the evidence overruling the calendar — the score says waiting for the diary is
 * a mistake, so the same conversation opens early. `expansion-ready` is the
 * opposite evidence: the customer has said they want more, nothing is wrong, and
 * the renewal is still far enough off that waiting for it would let the moment
 * pass.
 *
 * Expansion is deliberately the last of the three to be considered. A customer
 * who is both critical and interested in more is a churn conversation — the
 * expansion is what is at risk, not what is on offer — and a renewal already
 * inside its window is the conversation to have rather than a second one about
 * the same account in the same week.
 *
 * They are recorded apart and act identically on purpose. A retention feature
 * that answers churn with its own sender, its own hold and its own guardrails
 * ends up with two machines that disagree about whether a customer may be
 * written to, and the second one is always the one nobody audits. What differs
 * between these two is the DATE the conversation became due, which is a column,
 * not a subsystem.
 */
export const LIFECYCLE_TRIGGER_KINDS = [
  "renewal-due",
  "churn-risk",
  "expansion-ready",
] as const;
export type LifecycleTriggerKind = (typeof LIFECYCLE_TRIGGER_KINDS)[number];

/**
 * What the outbound loop said when it was last offered this trigger.
 *
 * `held` means a message was drafted and is waiting out its hold window;
 * `skipped` means the loop declined and said why. There is deliberately no
 * `sent`: whether a held message actually leaves is decided at the far end of
 * the window by `send-guardrails.ts`, and copying that outcome here would be a
 * second record of a send that could disagree with `crm_outbound_messages`.
 */
export const LIFECYCLE_TRIGGER_OUTCOMES = ["held", "skipped"] as const;
export type LifecycleTriggerOutcome = (typeof LIFECYCLE_TRIGGER_OUTCOMES)[number];

/**
 * One renewal conversation, opened once per contract per term.
 *
 * This table holds no message, no hold and no send. It holds the fact that a
 * term crossed a threshold, the opportunity that was opened for it, and what the
 * existing outbound loop answered each time it was asked to work that
 * opportunity. Everything downstream of "asked" already exists —
 * `autonomous_decisions` is the ledger, `autonomy_holds` is the window,
 * `crm_outbound_messages` is the message — and this row points at them rather
 * than restating them.
 *
 * `term_started_on` rather than a fired-at date is what makes the trigger
 * idempotent. A renewal ADVANCES `customer_lifecycles.started_on` (see the note
 * on `CUSTOMER_LIFECYCLE_STATUSES`), so the next term is a different value and
 * fires its own trigger, while a nightly sweep over the same term finds the row
 * already there. Keying on the lifecycle alone would open one renewal
 * conversation per customer forever; keying on the date the sweep ran would open
 * one per night.
 */
export const customerLifecycleTriggers = pgTable(
  "customer_lifecycle_triggers",
  {
    customerLifecycleTriggerId: text("customer_lifecycle_trigger_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    customerLifecycleId: text("customer_lifecycle_id").notNull(),

    /**
     * Denormalised from the lifecycle, and worth the copy.
     *
     * The loop is offered a party, so this is the value actually handed over.
     * Reading it back through the lifecycle on every offer would make the
     * hand-off depend on a join that a merged party can move underneath it.
     */
    partyId: text("party_id").notNull(),

    kind: text("kind").$type<LifecycleTriggerKind>().notNull(),

    /** The term this fired for. The idempotency key; see the table's note. */
    termStartedOn: date("term_started_on").notNull(),
    /** The renewal date as it stood when this fired, so the log reads alone. */
    renewalOn: date("renewal_on").notNull(),

    /**
     * The day the conversation became due — NOT the day the sweep noticed.
     *
     * This is the value written onto the opportunity as its next-step date, and
     * the outbound loop's `next-step-overdue` branch reads it. Dating it to the
     * sweep would make every trigger look freshly due no matter how long it had
     * been ignored, and a loop that only ever sees "due today" cannot tell an
     * overdue renewal from one that came up this morning.
     */
    dueOn: date("due_on").notNull(),

    /** The lifecycle's risk score at the moment this fired. 0..100. */
    riskScore: integer("risk_score").notNull(),
    /**
     * The health score at the moment this fired, or NULL for "the model could
     * not say" — carried from `customer_health_assessments.score`, which is
     * nullable for exactly that reason. Null is not zero here either.
     */
    healthScore: integer("health_score"),

    /**
     * The renewal opportunity: an ordinary open deal the existing pipeline works.
     *
     * Nullable only between claiming the term and opening the opportunity, which
     * is a window of one statement. It is claimed first on purpose — the unique
     * index below is what stops two concurrent sweeps opening two opportunities
     * for one contract, and a claim that happened after the deal was created
     * would leave the loser's deal orphaned in the pipeline.
     */
    opportunityDealId: integer("opportunity_deal_id"),

    /**
     * How many times the loop has been offered this trigger, and when last.
     *
     * The loop declines for reasons that expire — they replied, the ball is
     * ours, the system wrote to them four days ago — so a trigger the loop
     * refused is re-offered rather than abandoned. Without a counter and a
     * timestamp the re-offer has no interval, and a sweep on a cron would pay
     * for a draft on every pass.
     */
    attempts: integer("attempts").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at"),

    outcome: text("outcome").$type<LifecycleTriggerOutcome>(),
    /** Where the loop stopped. NULL exactly when it did not stop; see the CHECK. */
    refusalStage: text("refusal_stage"),
    /** The loop's own sentence, stored verbatim so the log needs no translation. */
    refusalReason: text("refusal_reason"),

    /** What the loop produced, when it produced something. */
    autonomyHoldId: text("autonomy_hold_id"),
    autonomousDecisionId: text("autonomous_decision_id"),
    outboundMessageId: text("outbound_message_id"),

    firedAt: timestamp("fired_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One conversation per contract per term. The claim, and the whole reason a
     * sweep is safe to run on a schedule.
     *
     * Deliberately not carrying `kind`: a term whose renewal-due trigger has
     * already fired must not fire a second, churn-risk one and open a second
     * opportunity for the same contract. The kind records WHY the one
     * conversation opened when it did.
     */
    uniqueIndex("uniq_customer_lifecycle_triggers_term").on(
      t.organizationId,
      t.customerLifecycleId,
      t.termStartedOn,
    ),

    /** The log read: what fired, newest first. */
    index("idx_customer_lifecycle_triggers_fired").on(t.organizationId, t.firedAt),
    /** Every trigger against one customer — the account view's question. */
    index("idx_customer_lifecycle_triggers_party").on(t.organizationId, t.partyId),
  ],
);

export type CustomerLifecycleTriggerRow = typeof customerLifecycleTriggers.$inferSelect;
