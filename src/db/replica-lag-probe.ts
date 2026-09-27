import { sql } from "drizzle-orm";

export interface ReplicaHealthProbe {
  probe(): Promise<boolean>;
}

export class NullReplicaHealthProbe implements ReplicaHealthProbe {
  async probe(): Promise<boolean> {
    return true;
  }
}

const DEFAULT_MAX_LAG_MS = 5_000;

export interface ReplicaLagProbeDb {
  execute(query: ReturnType<typeof sql>): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export class PostgresReplicaLagProbe implements ReplicaHealthProbe {
  private readonly maxLagMs: number;

  constructor(
    private readonly db: ReplicaLagProbeDb,
    maxLagMs: number = DEFAULT_MAX_LAG_MS,
  ) {
    this.maxLagMs = maxLagMs;
  }

  async probe(): Promise<boolean> {
    try {
      const rows = await this.db.execute(sql`
        SELECT
          pg_last_xact_replay_timestamp() IS NOT NULL AS is_replica,
          EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms
      `);
      const row = rows[0];
      if (!row) return false;
      if (row.is_replica !== true) return false;
      const lagMs = Number(row.lag_ms);
      if (!isFinite(lagMs)) return false;
      return lagMs <= this.maxLagMs;
    } catch {
      return false;
    }
  }
}
