export interface Release {
  readonly releaseId: string;
  readonly schemaVersion: number;
  readonly eventVersion: number;
  readonly minSchemaVersion: number;
  readonly minEventVersion: number;
}

export interface RolloutPlan {
  readonly release: Release;
  readonly canaryCellId: string;
  readonly orderedCells: readonly [string, ...string[]];
}

export type CompatibilityResult =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

export interface SloSnapshot {
  readonly errorRatePercent: number;
  readonly p99LatencyMs: number;
  readonly availabilityPercent: number;
}

export type RolloutAction =
  | { readonly kind: "DEPLOY"; readonly cellId: string }
  | { readonly kind: "ROLLBACK"; readonly cellId: string; readonly reason: string }
  | { readonly kind: "COMPLETE" };

export interface RollbackPlan {
  readonly releaseId: string;
  readonly cellsToRevert: readonly string[];
  readonly previousReleaseId: string | null;
}

const ERROR_RATE_REGRESSION_THRESHOLD = 1.0;
const LATENCY_REGRESSION_RATIO = 0.2;
const AVAILABILITY_REGRESSION_THRESHOLD = 0.5;

export function checkCompatibility(
  release: Release,
  oldestSupportedSchemaVersion: number,
  oldestSupportedEventVersion: number,
): CompatibilityResult {
  if (oldestSupportedSchemaVersion < release.minSchemaVersion)
    return {
      compatible: false,
      reason: `Release requires schema ${release.minSchemaVersion} but ${oldestSupportedSchemaVersion} is still running`,
    };

  if (oldestSupportedEventVersion < release.minEventVersion)
    return {
      compatible: false,
      reason: `Release requires event version ${release.minEventVersion} but ${oldestSupportedEventVersion} is still running`,
    };

  return { compatible: true };
}

export function shouldRollBack(sloBefore: SloSnapshot, sloAfter: SloSnapshot): boolean {
  if (sloAfter.errorRatePercent - sloBefore.errorRatePercent > ERROR_RATE_REGRESSION_THRESHOLD)
    return true;

  if (sloBefore.p99LatencyMs > 0) {
    const latencyIncrease = (sloAfter.p99LatencyMs - sloBefore.p99LatencyMs) / sloBefore.p99LatencyMs;
    if (latencyIncrease > LATENCY_REGRESSION_RATIO) return true;
  }

  if (sloBefore.availabilityPercent - sloAfter.availabilityPercent > AVAILABILITY_REGRESSION_THRESHOLD)
    return true;

  return false;
}

export function nextRolloutAction(
  plan: RolloutPlan,
  deployedCells: readonly string[],
  sloPassed: boolean,
): RolloutAction {
  if (deployedCells.length === 0)
    return { kind: "DEPLOY", cellId: plan.orderedCells[0] };

  const lastDeployed = deployedCells.at(-1);
  if (lastDeployed === undefined)
    return { kind: "DEPLOY", cellId: plan.orderedCells[0] };

  if (!sloPassed)
    return { kind: "ROLLBACK", cellId: lastDeployed, reason: "SLO regression detected on cell" };

  if (deployedCells.length >= plan.orderedCells.length)
    return { kind: "COMPLETE" };

  const nextCell = plan.orderedCells[deployedCells.length];
  if (nextCell === undefined) return { kind: "COMPLETE" };

  return { kind: "DEPLOY", cellId: nextCell };
}

export function rollbackPlan(
  plan: RolloutPlan,
  deployedCells: readonly string[],
  previousReleaseId: string | null,
): RollbackPlan {
  const cellsToRevert = plan.orderedCells.filter((c) => deployedCells.includes(c));
  return {
    releaseId: plan.release.releaseId,
    cellsToRevert,
    previousReleaseId,
  };
}
