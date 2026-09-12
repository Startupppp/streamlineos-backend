import type { FittedModel } from "./logistic-regression";
import type { ForecastMetrics } from "./forecast-metrics";
import type { ForecastReadiness, NaiveReason } from "./forecast-cold-start";

/*
  What a training run reports, what a stored score looks like, and the active
  model as the service holds it. `forecast-training.service.ts` re-exports the
  public four, so callers import them from the service as before.
*/

export interface TrainingRejected {
  readonly trained: false;
  readonly reason: NaiveReason;
  readonly readiness: ForecastReadiness;
  /** Present whenever a fit actually ran, so a rejection can be argued with. */
  readonly learned: ForecastMetrics | null;
  readonly naive: ForecastMetrics | null;
}

export interface TrainingAccepted {
  readonly trained: true;
  readonly modelId: string;
  readonly readiness: ForecastReadiness;
  readonly trainingDeals: number;
  readonly holdoutDeals: number;
  readonly learned: ForecastMetrics;
  readonly naive: ForecastMetrics;
  readonly scored: number;
}

export type TrainingAttempt = TrainingAccepted | TrainingRejected;

export interface DealForecastScore {
  readonly dealId: number;
  readonly probability: number;
  readonly intervalLower: number;
  readonly intervalUpper: number;
  readonly expectedValueMinor: number;
  readonly asOf: string;
  readonly scoredAt: string;
  readonly factors: readonly {
    readonly feature: string;
    readonly value: number;
    readonly contribution: number;
    readonly direction: "increases" | "decreases";
  }[];
}

export interface ActiveModel {
  readonly modelId: string;
  readonly model: FittedModel;
  readonly trainedAt: Date;
  readonly becameAvailableAt: Date;
  readonly trainingDeals: number;
  readonly holdoutDeals: number;
  readonly learned: ForecastMetrics;
  readonly naive: ForecastMetrics;
}
