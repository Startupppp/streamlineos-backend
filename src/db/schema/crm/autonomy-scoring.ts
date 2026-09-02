import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { boolean, doublePrecision, foreignKey, index, integer, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import type { DecisionKind } from "./autonomous-decisions";

/**
 * The dials that govern autonomous behaviour, per organisation.
 *
 * In the database rather than the environment because adoption is meant to be
 * gradual: a tenant still deciding whether to trust the system wants more
 * scoring and a longer hold than one that already does, and neither should need
 * a deploy to say so.
 */
export const autonomySettings = pgTable("autonomy_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),

  /** Fraction of decisions given a second opinion. */
  shadowSampleRate: numeric("shadow_sample_rate", { precision: 4, scale: 3 })
    .default("0.100")
    .notNull(),
  /**
   * Hard stop on scoring volume per day.
   *
   * Scoring is itself inference, so an uncapped rate is a bill that scales with
   * how busy the tenant is — and the point of the cheap second pass is that it
   * stays cheap.
   */
  shadowDailyCap: integer("shadow_daily_cap").default(500).notNull(),

  /** Ticket 14: seconds an irreversible outbound waits before it leaves. */
  holdWindowSeconds: integer("hold_window_seconds").default(60).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

/** The defaults a tenant with no row resolves to. Stated once. */
export const AUTONOMY_SETTINGS_DEFAULTS = {
  shadowSampleRate: 0.1,
  shadowDailyCap: 500,
  holdWindowSeconds: 60,
} as const;

export const SHADOW_VERDICTS = ["agrees", "disagrees", "uncertain", "failed"] as const;
export type ShadowVerdict = (typeof SHADOW_VERDICTS)[number];

/**
 * A second, cheaper opinion on a decision already taken.
 *
 * It never writes anything to the record. Its only job is to disagree loudly
 * enough that a human looks — which, with no approval gate anywhere, is the
 * difference between measuring accuracy and asserting it.
 */
export const autonomyShadowScores = pgTable(
  "autonomy_shadow_scores",
  {
    autonomyShadowScoreId: text("autonomy_shadow_score_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    autonomousDecisionId: text("autonomous_decision_id").notNull(),

    kind: text("kind").$type<DecisionKind>().notNull(),
    verdict: text("verdict").$type<ShadowVerdict>().notNull(),
    score: doublePrecision("score"),
    /** One sentence, for the person the disagreement is routed to. */
    rationale: text("rationale"),

    model: text("model"),
    promptVersion: text("prompt_version"),

    /** Derived from verdict and original confidence, never taken from a caller. */
    needsReview: boolean("needs_review").default(false).notNull(),
    reviewedAt: timestamp("reviewed_at"),
    /** No FK to users — see migration 0223. */
    reviewedByUserId: text("reviewed_by_user_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // One second opinion per decision: scoring twice would let a retry
    // double-count a disagreement and move the scoreboard on no new information.
    uniqueIndex("uniq_autonomy_shadow_decision").on(t.organizationId, t.autonomousDecisionId),
    index("idx_autonomy_shadow_org_created").on(t.organizationId, t.createdAt),
    index("idx_autonomy_shadow_queue")
      .on(t.organizationId, t.createdAt)
      .where(sql`${t.needsReview} = true AND ${t.reviewedAt} IS NULL`),
    index("idx_autonomy_shadow_kind").on(t.organizationId, t.kind, t.createdAt),
  ],
);
