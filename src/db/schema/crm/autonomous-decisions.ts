import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, jsonb, doublePrecision, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Everything the system decided on its own, and why.
 *
 * Because nothing asks for approval, this table IS the oversight mechanism —
 * ticket 13's review feed is a reading of it, and ticket 15's scoreboard is a
 * counting of it. That makes two properties load-bearing:
 *
 * It has to be complete. A decision written without a row here is an action
 * nobody can review, which is worse than the action not happening.
 *
 * And it has to be honest about reversibility, because that is what tells a
 * reviewer whether they are looking at something they can undo, something still
 * inside its hold window, or something that has left the building.
 */

export const DECISION_KINDS = [
  "task.extracted",
  "stage.advanced",
  "party.created",
  "activity.logged",
  "quote.sent",
  /**
   * Ticket 07. A follow-up, nudge, check-in or meeting request the system wrote
   * and decided to send, under the same hold window as a quote.
   */
  "outbound.sent",
  /**
   * Ticket 09. Cold outreach, as its own kind rather than a class of the one
   * above — so an operator can stop every cold campaign on the platform without
   * stopping the follow-ups, which are a different risk and a different
   * argument. One kill switch per kind is what makes that possible.
   */
  "cold_outbound.sent",
  /**
   * Phase 4 ticket 10. A batch of deterministic field repairs, applied with
   * nobody watching.
   *
   * One row per batch rather than per value: four hundred identically malformed
   * numbers are one decision, and four hundred entries here would bury every
   * judgement in the feed under clerical work. The individual values live in
   * `autonomy_repairs`, which is what makes the batch undoable item by item as
   * well as whole.
   *
   * It is a decision kind rather than a private ledger so that the existing kill
   * switch, review feed, reversal path and scoreboard all reach it with no
   * second mechanism for an operator to remember.
   */
  "field.repaired",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * How much of this can be taken back.
 *
 * `instant` — a single reversing write undoes it completely.
 * `hold` — it has not left the building yet and cancelling still prevents it.
 * `irreversible` — it reached a customer; only a correction is possible.
 */
export const REVERSIBILITY_CLASSES = ["instant", "hold", "irreversible"] as const;
export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

export const DECISION_OUTCOMES = ["applied", "held", "skipped", "reversed", "failed"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const autonomousDecisions = pgTable(
  "autonomous_decisions",
  {
    autonomousDecisionId: text("autonomous_decision_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    kind: text("kind").$type<DecisionKind>().notNull(),
    outcome: text("outcome").$type<DecisionOutcome>().notNull(),

    /** What made this happen — the inbound receipt, usually. */
    triggerType: text("trigger_type").notNull(),
    triggerId: text("trigger_id"),

    /** What it acted on, so a reviewer can open the record. */
    partyId: text("party_id"),
    dealId: text("deal_id"),
    activityId: text("activity_id"),

    /**
     * The identifiers a regression is traced through.
     *
     * A prompt change that quietly halves accuracy is invisible without the
     * prompt version beside the model, so both are columns rather than metadata.
     */
    model: text("model"),
    promptVersion: text("prompt_version"),
    confidence: doublePrecision("confidence"),

    /**
     * What the decision considered, capped by the caller.
     *
     * Enough for a reviewer to judge whether the conclusion follows — never the
     * whole context window, which would make this table larger than the mail it
     * describes.
     */
    inputs: jsonb("inputs").$type<Record<string, unknown>>(),
    /** What it concluded, in the shape the extractor returned. */
    decision: jsonb("decision").$type<Record<string, unknown>>(),
    /** One sentence a person reads. Never a model's own reasoning about policy. */
    summary: text("summary"),

    reversibility: text("reversibility").$type<ReversibilityClass>().notNull(),
    /** Set when a human took it back, which is what ticket 15 measures against. */
    reversedAt: timestamp("reversed_at"),
    /**
     * Who took it back. Deliberately *not* a foreign key to `users`.
     *
     * Two reasons, and either alone is sufficient. `scripts/purge-user.mjs`
     * deletes every row whose column references `users`, so an edge here would
     * destroy the audit record of an autonomous action because some unrelated
     * person once reversed it. And `ON DELETE SET NULL` contradicted
     * `chk_autonomous_decisions_reversal`, which requires this and `reversedAt`
     * to be NULL together -- a cascade nulling one but not the other raises
     * 23514.
     *
     * A ledger records who acted, and that record has to outlive the row
     * describing them. `deal_stage_transitions.actor_user_id` does the same.
     * See migration 0223.
     */
    reversedByUserId: text("reversed_by_user_id"),
    reversedReason: text("reversed_reason"),

    decidedAt: timestamp("decided_at").defaultNow().notNull(),
  },
  (t) => [
    // The review feed: everything, newest first.
    index("idx_autonomous_decisions_feed").on(t.organizationId, t.decidedAt),
    // The scoreboard: accuracy per action type over time.
    index("idx_autonomous_decisions_kind").on(t.organizationId, t.kind, t.decidedAt),
    // What is still reversible, and what a person already took back.
    index("idx_autonomous_decisions_reversed").on(t.organizationId, t.reversedAt),
    index("idx_autonomous_decisions_deal").on(t.organizationId, t.dealId, t.decidedAt),
    /**
     * The composite tenant key `autonomy_corrections` points at (migration
     * 0224). Postgres will not accept a composite foreign key without a unique
     * constraint covering exactly its referenced columns, and this table's
     * primary key is the id alone.
     */
    unique("uniq_autonomous_decisions_org_id").on(t.organizationId, t.autonomousDecisionId),
  ],
);
