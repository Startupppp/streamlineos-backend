import {
  FINDING_SEVERITIES,
  type DataQualityProducer,
  type FindingSeverity,
} from "../../db/schema/crm/data-quality";
import { SEVERITY_WEIGHTS, weightedOpenCount } from "./finding-vocabulary";

/**
 * The dataset's health as one number, decomposed by the class of problem behind
 * it, and the direction that number is moving.
 *
 * Pure, and separate from the service for the reason `finding-vocabulary.ts`
 * gives: whether working the queue improved the dataset should be arguable
 * against a test rather than against a running database. The weights are not
 * restated here — `SEVERITY_WEIGHTS` is the one table, and a second copy would
 * be two answers to "how bad is a stale lead".
 */

/** One `GROUP BY producer, severity` row over the open queue. */
export interface OpenFindingCount {
  readonly producer: DataQualityProducer;
  readonly severity: FindingSeverity;
  readonly count: number;
}

/**
 * What one class of problem contributes.
 *
 * `count` and `weight` both, never one: "four hundred findings" and "worth 400"
 * are the same class of noise, while "two findings" and "worth 16" is the pair
 * that tells somebody the small number is the one to work first.
 */
export interface DatasetHealthClass {
  readonly producer: DataQualityProducer;
  readonly count: number;
  readonly weight: number;
}

export interface DatasetHealth {
  /** The open queue weighted by severity. Lower is better; zero is clean. */
  readonly composite: number;
  readonly openTotal: number;
  readonly bySeverity: Readonly<Record<FindingSeverity, number>>;
  /** Heaviest first, because that is the order somebody would work them in. */
  readonly byClass: readonly DatasetHealthClass[];
}

/** Every severity present, so a caller never has to decide what a gap means. */
function severityMap(counts: readonly OpenFindingCount[]): Record<FindingSeverity, number> {
  const map: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const row of counts) map[row.severity] += row.count;
  return map;
}

/**
 * The composite, and what it is made of.
 *
 * A penalty rather than a score out of a hundred, for the reason
 * `weightedOpenCount` records: the honest denominator — how many records *could*
 * have been wrong — is not something the queue knows, and inventing one would
 * make the number look like a percentage while behaving like nothing.
 */
export function datasetHealth(counts: readonly OpenFindingCount[]): DatasetHealth {
  const byClass = new Map<DataQualityProducer, { count: number; weight: number }>();

  for (const row of counts) {
    const entry = byClass.get(row.producer) ?? { count: 0, weight: 0 };
    entry.count += row.count;
    entry.weight += SEVERITY_WEIGHTS[row.severity] * row.count;
    byClass.set(row.producer, entry);
  }

  const bySeverity = severityMap(counts);

  return {
    // Reduced over the severity map rather than the raw rows, so a producer
    // appearing twice at one severity cannot be counted twice here and once in
    // `byClass`. `weightedOpenCount` stays the only place a weight is applied.
    composite: weightedOpenCount(
      FINDING_SEVERITIES.map((severity) => ({ severity, count: bySeverity[severity] })),
    ),
    openTotal: counts.reduce((total, row) => total + row.count, 0),
    bySeverity,
    byClass: [...byClass.entries()]
      .map(([producer, entry]) => ({ producer, ...entry }))
      // Ties broken by name so two tenants with the same shape read the same and
      // a snapshot's `by_class` does not reorder itself between captures.
      .sort((a, b) => b.weight - a.weight || a.producer.localeCompare(b.producer)),
  };
}

export const HEALTH_DIRECTIONS = ["improving", "worsening", "unchanged"] as const;
export type HealthDirection = (typeof HEALTH_DIRECTIONS)[number];

/**
 * Which way the number went since the oldest point in the window.
 *
 * `null` when there is nothing to compare against — a tenant whose queue was
 * switched on yesterday has no direction, and rendering that as "unchanged"
 * would be the same reassuring lie the autonomy scoreboard refuses when it
 * returns a null correction rate instead of zero percent.
 *
 * Improving means the composite fell, because the composite is a penalty. That
 * inversion is the one thing worth saying out loud in a name.
 */
export function healthDirection(
  composite: number,
  baseline: number | null,
): HealthDirection | null {
  if (baseline === null) return null;
  if (composite < baseline) return "improving";
  if (composite > baseline) return "worsening";
  return "unchanged";
}
