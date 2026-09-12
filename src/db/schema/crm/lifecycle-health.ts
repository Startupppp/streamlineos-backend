import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { crmHealthEnum } from "../common/enums";

/* ────────────────────────────────────────────────────────────────────────────
 * Customer health: a composite score that can be taken apart.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four inputs a customer health score is made of.
 *
 * Fixed, and small. A health model whose input set is tenant-configurable
 * produces numbers that cannot be compared between two customers of the same
 * organisation once somebody edits the configuration, and there is already one
 * of those here: `health_score_config.weights` is a jsonb blob of five weights
 * with no version, so every historical row in `client_health_scores` silently
 * restates itself the moment it is edited.
 *
 * Each key names the QUESTION, never the table it happens to be answered from.
 * `support` is "how has service for this customer gone", and the fact that it is
 * currently read from `support_tickets` is a detail of `health.service.ts`, not
 * of the vocabulary a stored score is decomposed into.
 */
export const HEALTH_FACTOR_KEYS = [
  /** Are they using what they bought. */
  "usage",
  /** Is anybody on either side still talking. */
  "engagement",
  /** How has service for this customer gone. */
  "support",
  /** What did they sound like when they talked to us. */
  "sentiment",
] as const;
export type HealthFactorKey = (typeof HEALTH_FACTOR_KEYS)[number];

/** Whether an input was measured, or is being reported as absent. */
export const HEALTH_FACTOR_STATUSES = ["measured", "missing"] as const;
export type HealthFactorStatus = (typeof HEALTH_FACTOR_STATUSES)[number];

/**
 * Why an input is missing — three different facts, kept apart.
 *
 * `cs-health.service.ts` scores all three of these as `NEUTRAL_BASELINE = 50`,
 * which is the failure this vocabulary exists to prevent: a customer nobody has
 * ever surveyed and a customer whose survey came back neutral get the same
 * number, so the score cannot be argued with and the gap in the data never gets
 * fixed because nothing ever reports one.
 */
export const HEALTH_MISSING_REASONS = [
  /**
   * The organisation holds no source for this input at all — nobody records
   * activities, no ticket is anchored to a party, no usage observation has ever
   * been filed. Not a fact about this customer.
   */
  "no-source",
  /** The source is in use, but nothing has ever been observed for this customer. */
  "no-observations",
  /** Something was observed for this customer, all of it older than the window. */
  "stale",
] as const;
export type HealthMissingReason = (typeof HEALTH_MISSING_REASONS)[number];

/**
 * The current health of one customer, and the only place the composite lives.
 *
 * One row per party, replaced in place. Deliberately NOT an append-only history:
 * the inputs are read over moving windows against tables that are themselves
 * edited, so a row from March cannot be re-derived and a history of them would
 * be a pile of numbers nobody can check — which is what `client_health_scores`
 * already is. What makes a score here answerable is the factor rows beside it,
 * not a row from last quarter.
 *
 * `score` is NULLABLE and that is the whole point of the table. Null means the
 * model did not have enough of its inputs to answer, which is a different fact
 * from zero and from fifty, and it is carried all the way out to
 * `business_parties.health_score` rather than being rounded into a number
 * somebody would act on.
 */
export const customerHealthAssessments = pgTable(
  "customer_health_assessments",
  {
    customerHealthAssessmentId: text("customer_health_assessment_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The customer, as a Party — the same anchor `customer_lifecycles` uses.
     *
     * Not `client_account_id`, which is what `client_health_scores` is keyed on:
     * that is a legacy identity, and a health score anchored to it is invisible
     * to every party-native surface and doubles up for any customer whose two
     * legacy records were merged into one Party.
     */
    partyId: text("party_id").notNull(),

    /**
     * 0..100, or NULL for "not enough inputs to say".
     *
     * Null and zero are different claims and this column is allowed to make
     * both. See `MIN_HEALTH_COVERAGE_BPS` in `health-score.ts` for where the
     * line is drawn and why.
     */
    score: integer("score"),

    /**
     * The band, in `crm_health`'s own vocabulary rather than a fourth spelling
     * of it. `business_parties.health_status` is this enum, and the write-back
     * would otherwise need a translation table that could disagree with itself.
     * Null exactly when `score` is null, enforced by a CHECK.
     */
    healthStatus: crmHealthEnum("health_status"),

    /**
     * How much of the model's declared weight actually spoke, in basis points.
     *
     * Stored beside the score because it is the number that says how much the
     * score is worth: 68 out of a model that had two of its four inputs is not
     * the same claim as 68 out of a model that had all four, and a surface that
     * cannot tell them apart will present them identically.
     */
    coverageBps: integer("coverage_bps").notNull(),

    /**
     * Which weight table produced this. Bumped whenever the weights change.
     *
     * Without it, re-tuning the model silently restates every stored score —
     * the same defect as `health_score_config`, which has no version at all.
     */
    weightsVersion: integer("weights_version").notNull(),

    computedAt: timestamp("computed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** One current assessment per customer. The upsert's conflict target. */
    uniqueIndex("uniq_customer_health_assessments_party").on(
      t.organizationId,
      t.partyId,
    ),
    /**
     * The roster read: worst first. Postgres orders NULLs last under ASC, which
     * is the order this wants anyway — an unscored customer is not the worst
     * customer, it is an unanswered question, and it belongs after the answers.
     */
    index("idx_customer_health_assessments_score").on(t.organizationId, t.score),
    /** The composite tenant key the factor table points at. */
    unique("uniq_customer_health_assessments_org_id").on(
      t.organizationId,
      t.customerHealthAssessmentId,
    ),
  ],
);

/**
 * One input of one score, with everything needed to argue about it.
 *
 * A row per input rather than a `breakdown` jsonb blob — which is what
 * `client_health_scores` stores — for two reasons that only rows give you. A
 * blob cannot be queried ("which customers are unscored because nobody records
 * their activity"), and a blob cannot be constrained: the invariant that a
 * missing input has no value and a measured one has no reason is a CHECK here
 * and would be a convention there.
 *
 * The window is on the row because the inputs do not share one. Support and
 * sentiment are read over six months because tickets and surveys are sparse;
 * engagement and usage over three, because a quarter of silence is already the
 * answer. A score whose factors are reported without their windows invites the
 * reader to assume they share one.
 */
export const customerHealthFactors = pgTable(
  "customer_health_factors",
  {
    customerHealthFactorId: text("customer_health_factor_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    customerHealthAssessmentId: text("customer_health_assessment_id").notNull(),

    factorKey: text("factor_key").$type<HealthFactorKey>().notNull(),

    /** What this input is declared to be worth, before any input went missing. */
    weightBps: integer("weight_bps").notNull(),
    /**
     * What it was actually worth in this score, after the missing inputs' weight
     * was redistributed across the ones that spoke. Zero for a missing input.
     *
     * Both are stored because the difference is the interesting part: an input
     * declared at 2500 that carried 3800 of a particular score is doing more
     * work than the model says it should, and only the pair says so.
     */
    effectiveWeightBps: integer("effective_weight_bps").default(0).notNull(),

    status: text("status").$type<HealthFactorStatus>().notNull(),
    /** 0..100. NULL exactly when the input is missing — a CHECK enforces it. */
    value: integer("value"),
    /** NULL exactly when the input is measured. */
    missingReason: text("missing_reason").$type<HealthMissingReason>(),

    /**
     * `value * effective_weight_bps`, so the composite reconstructs exactly:
     * `score = round(sum(contribution_bps) / 10000)`.
     *
     * Stored rather than multiplied on read because rounding is where a
     * decomposition stops adding up, and a breakdown whose parts do not sum to
     * the whole is worse than no breakdown — it teaches the reader the number is
     * approximate when it is not.
     */
    contributionBps: integer("contribution_bps").default(0).notNull(),

    /** How many underlying observations the value was computed from. */
    observations: integer("observations").default(0).notNull(),

    windowDays: integer("window_days").notNull(),
    windowFrom: timestamp("window_from").notNull(),
    windowTo: timestamp("window_to").notNull(),

    /**
     * The raw counts behind the value — the layer below the decomposition.
     *
     * Scalars only, and never read to make a decision: this is what a person
     * looks at when they disagree with the number, which is the level at which
     * an argument about a health score is actually settled.
     */
    detail: jsonb("detail").$type<Record<string, number | null>>().default({}).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * One row per input per assessment, and the composite foreign key's own
     * delete-time lookup — one index serves both, tenant column leading.
     */
    uniqueIndex("uniq_customer_health_factors_key").on(
      t.organizationId,
      t.customerHealthAssessmentId,
      t.factorKey,
    ),
  ],
);

export type CustomerHealthAssessmentRow = typeof customerHealthAssessments.$inferSelect;
export type CustomerHealthFactorRow = typeof customerHealthFactors.$inferSelect;
