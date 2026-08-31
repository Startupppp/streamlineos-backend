export interface CellSloMeasurement {
  readonly cellId: string;
  readonly p99LatencyMs: number;
  readonly errorRatePercent: number;
  readonly availabilityPercent: number;
}

export interface SloThresholds {
  readonly maxP99LatencyMs: number;
  readonly maxErrorRatePercent: number;
  readonly minAvailabilityPercent: number;
}

export interface CellSloStatus {
  readonly cellId: string;
  readonly healthy: boolean;
  readonly measurement: CellSloMeasurement;
}

export interface PlatformSloRollup {
  readonly healthy: boolean;
  readonly worstCell: CellSloStatus;
  readonly cells: readonly CellSloStatus[];
}

function isCellHealthy(m: CellSloMeasurement, thresholds: SloThresholds): boolean {
  return (
    m.p99LatencyMs <= thresholds.maxP99LatencyMs &&
    m.errorRatePercent <= thresholds.maxErrorRatePercent &&
    m.availabilityPercent >= thresholds.minAvailabilityPercent
  );
}

function worstFirst(a: CellSloStatus, b: CellSloStatus): number {
  if (!a.healthy && b.healthy) return -1;
  if (a.healthy && !b.healthy) return 1;
  return b.measurement.errorRatePercent - a.measurement.errorRatePercent;
}

export function rollupSlo(
  measurements: readonly [CellSloMeasurement, ...CellSloMeasurement[]],
  thresholds: SloThresholds,
): PlatformSloRollup {
  const cells: CellSloStatus[] = measurements.map((m) => ({
    cellId: m.cellId,
    healthy: isCellHealthy(m, thresholds),
    measurement: m,
  }));

  const sorted = [...cells].sort(worstFirst);
  const worstCell = sorted[0];

  if (worstCell === undefined)
    throw new Error("rollupSlo: measurements must be non-empty");

  const healthy = cells.every((c) => c.healthy);

  return { healthy, worstCell, cells };
}
