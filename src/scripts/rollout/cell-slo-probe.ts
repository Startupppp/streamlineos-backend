import postgres from "postgres";
import type { CellSloMeasurement } from "../../common/placement/cell-slo-rollup";

export type WorkloadKind = "normal" | "regressed";

export interface CellProbeConfig {
  readonly cellId: string;
  readonly appUrl: string;
  readonly orgId: string;
  readonly sampleCount: number;
  readonly workload: WorkloadKind;
}

type Sql = ReturnType<typeof postgres>;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowVal = sorted[low] ?? 0;
  const highVal = sorted[high] ?? 0;
  if (low === high) return lowVal;
  return lowVal + (highVal - lowVal) * (rank - low);
}

function assertNeverWorkload(k: never): never {
  throw new Error(`Unknown workload kind: ${String(k)}`);
}

async function runQuery(
  sql: Sql,
  orgId: string,
  kind: WorkloadKind,
): Promise<void> {
  switch (kind) {
    case "normal":
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        await tx`SELECT 1 AS ok`;
      });
      return;
    case "regressed":
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        await tx`SELECT count(*)::int AS n FROM (SELECT md5(n::text) AS h FROM generate_series(1, 200000) n ORDER BY h) sub`;
        await tx`SELECT pg_sleep(1)`;
      });
      return;
    default:
      return assertNeverWorkload(kind);
  }
}

export async function measureCellSlo(
  config: CellProbeConfig,
): Promise<CellSloMeasurement> {
  const sql = postgres(config.appUrl, {
    max: 4,
    prepare: false,
    onnotice: () => {},
  });
  const durations: number[] = [];
  let errors = 0;

  try {
    for (let i = 0; i < config.sampleCount; i++) {
      const t0 = process.hrtime.bigint();
      try {
        await runQuery(sql, config.orgId, config.workload);
        durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
      } catch {
        errors += 1;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const total = config.sampleCount;
  const sorted = [...durations].sort((a, b) => a - b);
  const p99LatencyMs = percentile(sorted, 99);
  const errorRatePercent = (errors / total) * 100;
  const availabilityPercent = ((total - errors) / total) * 100;

  return {
    cellId: config.cellId,
    p99LatencyMs,
    errorRatePercent,
    availabilityPercent,
  };
}
