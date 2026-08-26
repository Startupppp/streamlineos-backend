import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { deals } from "./deals";

/** What the fit produced, stored so a score can be reproduced from it. */
export interface StoredCoefficients {
  readonly intercept: number;
  readonly weights: Record<string, number>;
  readonly means: Record<string, number>;
  readonly deviations: Record<string, number>;
  /** Inverse penalised Fisher information, intercept first. */
  readonly covariance: number[][];
}

export interface StoredForecastMetrics {
  readonly count: number;
  readonly brier: number;
  readonly logLoss: number;
  readonly auc: number;
  readonly calibrationError: number;
  readonly baseRate: number;
}

export interface StoredForecastEvaluation {
  readonly learned: StoredForecastMetrics;
  readonly naive: StoredForecastMetrics;
}

export interface StoredScoreFactor {
  readonly feature: string;
  readonly value: number;
  readonly standardised: number;
  readonly contribution: number;
  readonly direction: "increases" | "decreases";
}

/**
 * One tenant's own forecast, and the evidence it is allowed to claim it.
 *
 * Per organisation, because a global model encodes the average customer's sales
 * process and no customer has that process — a two-week transactional pipeline
 * and a nine-month enterprise one disagree about what a thirty-day-old deal
 * means, and a model trained across both is wrong for each.
 *
 * The row carries the whole model rather than a pointer to one: coefficients,
 * the standardisation they were fitted under and the covariance the intervals
 * come from. That is what makes a score reproducible months later, when the
 * training deals have moved on and nobody can re-derive it.
 *
 * `became_available_at` is the moment this organisation first had a learned
 * forecast at all, carried forward across every retrain. Ticket 06 turns on it:
 * crossing the threshold has to be a thing that happened at a time, not a state
 * the surface infers.
 */
export const crmDealForecastModels = pgTable(
  "crm_deal_forecast_models",
  {
    crmDealForecastModelId: text("crm_deal_forecast_model_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** The vocabulary the coefficients were fitted against. */
    featureSpecVersion: text("feature_spec_version").notNull(),
    /** `active` or `superseded`. One active row per organisation. */
    status: text("status").default("active").notNull(),

    trainedAt: timestamp("trained_at").defaultNow().notNull(),
    becameAvailableAt: timestamp("became_available_at").defaultNow().notNull(),

    trainingDeals: integer("training_deals").notNull(),
    holdoutDeals: integer("holdout_deals").notNull(),
    wonDeals: integer("won_deals").notNull(),
    lostDeals: integer("lost_deals").notNull(),

    coefficients: jsonb("coefficients").$type<StoredCoefficients>().notNull(),
    evaluation: jsonb("evaluation").$type<StoredForecastEvaluation>().notNull(),

    ridge: doublePrecision("ridge").notNull(),
    iterations: integer("iterations").notNull(),
    converged: boolean("converged").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // The read is "this organisation's current model", which is every read.
    uniqueIndex("uniq_crm_deal_forecast_models_active")
      .on(t.organizationId)
      .where(sql`status = 'active'`),
    index("idx_crm_deal_forecast_models_org_trained").on(t.organizationId, t.trainedAt),
    unique("uniq_crm_deal_forecast_models_org_id").on(
      t.organizationId,
      t.crmDealForecastModelId,
    ),
  ],
);

/**
 * The latest score for one open deal, and what the model saw when it produced it.
 *
 * `features` is stored beside the answer on purpose. Without it a rep who
 * disagrees with a number has nothing to argue with — the deal has moved on by
 * the time they look, so recomputing gives a different answer and the
 * disagreement becomes unresolvable. With it, the arithmetic is
 * `intercept + Σ wᵢzᵢ` over values they can check against the deal.
 *
 * One row per deal, replaced by the daily pass, because the history that matters
 * for accuracy is the closed deals themselves rather than a score trail.
 */
export const crmDealForecastScores = pgTable(
  "crm_deal_forecast_scores",
  {
    crmDealForecastScoreId: text("crm_deal_forecast_score_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id").notNull(),
    crmDealForecastModelId: text("crm_deal_forecast_model_id").notNull(),

    /** The moment the features describe, not the moment the row was written. */
    asOf: timestamp("as_of").notNull(),
    scoredAt: timestamp("scored_at").defaultNow().notNull(),

    probability: doublePrecision("probability").notNull(),
    intervalLower: doublePrecision("interval_lower").notNull(),
    intervalUpper: doublePrecision("interval_upper").notNull(),

    /** Probability times the deal's value, in the organisation's minor units. */
    expectedValueMinor: bigint("expected_value_minor", { mode: "number" }).notNull(),

    features: jsonb("features").$type<Record<string, number>>().notNull(),
    factors: jsonb("factors").$type<StoredScoreFactor[]>().notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_crm_deal_forecast_scores_deal").on(t.organizationId, t.dealId),
    index("idx_crm_deal_forecast_scores_org_scored").on(t.organizationId, t.scoredAt),
    unique("uniq_crm_deal_forecast_scores_org_id").on(
      t.organizationId,
      t.crmDealForecastScoreId,
    ),
    foreignKey({
      columns: [t.organizationId, t.dealId],
      foreignColumns: [deals.orgId, deals.id],
      name: "fk_crm_deal_forecast_scores_deal",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.crmDealForecastModelId],
      foreignColumns: [
        crmDealForecastModels.organizationId,
        crmDealForecastModels.crmDealForecastModelId,
      ],
      name: "fk_crm_deal_forecast_scores_model",
    }).onDelete("cascade"),
  ],
);
