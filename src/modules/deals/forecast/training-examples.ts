/**
 * Turning closed deals into labelled examples without telling them the answer.
 *
 * A closed deal knows how it ended, and almost every column on it has been
 * touched by that ending: the stage is the terminal one, the probability was set
 * to 100 or 0 by the transition itself, the last activity is the one saying it
 * was signed. Assembling features at the close date produces a model that
 * predicts the past perfectly and the future not at all — the classic leak, and
 * the one that makes a forecast look excellent in testing and useless in use.
 *
 * So a training example is the deal as it stood a fixed horizon BEFORE it
 * closed: thirty days, or the day it was created if it did not live that long.
 * Thirty because it is far enough back that the closing paperwork has not
 * happened yet, and near enough that most deals still exist — a ninety-day
 * horizon would discard every transactional pipeline entirely.
 */
import {
  FORECAST_FEATURE_CAPS,
  type DealOutcome,
  type HistoricalRates,
  type OutcomeCounts,
  type StageMove,
} from "./deal-forecast-features";

/** How far before its close a deal is looked at, when it is used as an example. */
export const FORECAST_TRAINING_HORIZON_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ClosedDealRecord {
  readonly dealId: number;
  readonly createdAt: Date;
  readonly closedAt: Date;
  readonly outcome: DealOutcome;
  readonly assignedToId: string | null;
  readonly sourceKey: string | null;
}

/**
 * The moment a closed deal is looked at: a horizon before its close, but never
 * before it existed.
 */
export function trainingAsOf(
  createdAt: Date,
  closedAt: Date,
  horizonDays = FORECAST_TRAINING_HORIZON_DAYS,
): Date {
  const target = closedAt.getTime() - horizonDays * DAY_MS;
  return new Date(Math.max(createdAt.getTime(), Math.min(target, closedAt.getTime())));
}

/**
 * Which stage the deal was in at a moment, read off the ledger.
 *
 * Three cases, in order. The last move at or before the moment names the stage
 * it landed in. Failing that, the first move after it names the stage it came
 * FROM, which is where it must have been. Failing both — a deal with no ledger
 * at all, which every deal created before the ledger existed is — the deal's
 * present stage is the only answer available, and for an open deal that is the
 * right one anyway.
 */
export function stageAt(
  moves: readonly StageMove[],
  asOf: Date,
  fallbackStage: string,
): string {
  const ordered = [...moves].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  let landed: string | null = null;
  for (const move of ordered) {
    if (move.occurredAt.getTime() > asOf.getTime()) break;
    landed = move.toStage;
  }
  if (landed !== null) return landed;

  const first = ordered[0];
  if (first !== undefined) return first.fromStage ?? first.toStage;

  return fallbackStage;
}

/** Only the ledger the deal had at that moment. */
export function movesBefore(moves: readonly StageMove[], asOf: Date): StageMove[] {
  return moves
    .filter((move) => move.occurredAt.getTime() <= asOf.getTime())
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .slice(-FORECAST_FEATURE_CAPS.maxStageMoves);
}

function bump(
  index: Map<string, { won: number; total: number }>,
  key: string | null,
  outcome: DealOutcome,
): void {
  if (key === null) return;
  const existing = index.get(key) ?? { won: 0, total: 0 };
  existing.total += 1;
  if (outcome === "won") existing.won += 1;
  index.set(key, existing);
}

/**
 * The tenant's own win rates, by rep and by source, from the same closed deals
 * the model is fitted on.
 *
 * Built once per training run rather than once per example, which is what makes
 * the whole assembly cheap; the leave-one-out subtraction in the feature
 * assembler is what keeps it honest.
 */
export function buildHistoricalRates(closed: readonly ClosedDealRecord[]): HistoricalRates {
  const byRep = new Map<string, { won: number; total: number }>();
  const bySource = new Map<string, { won: number; total: number }>();
  let won = 0;

  for (const deal of closed) {
    if (deal.outcome === "won") won += 1;
    bump(byRep, deal.assignedToId, deal.outcome);
    bump(bySource, deal.sourceKey, deal.outcome);
  }

  return {
    baseline: { won, total: closed.length },
    byRep: byRep as ReadonlyMap<string, OutcomeCounts>,
    bySource: bySource as ReadonlyMap<string, OutcomeCounts>,
  };
}

/** How many of each outcome a set of closed deals holds. */
export function countOutcomes(closed: readonly ClosedDealRecord[]): {
  won: number;
  lost: number;
} {
  const won = closed.filter((deal) => deal.outcome === "won").length;
  return { won, lost: closed.length - won };
}
