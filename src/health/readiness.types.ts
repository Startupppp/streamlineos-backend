export type DependencyState = "up" | "degraded" | "down" | "skipped";

export type ReadinessStatus = "ready" | "degraded" | "unready";

export type DependencyOutcome =
  | { state: "up"; detail?: string }
  | { state: "degraded"; detail: string }
  | { state: "down"; detail: string }
  | { state: "skipped"; detail: string };

export interface DependencyReport {
  readonly name: string;
  readonly state: DependencyState;
  readonly required: boolean;
  readonly latencyMs: number;
  readonly detail: string | null;
}

export interface ReadinessSnapshot {
  readonly status: ReadinessStatus;
  readonly checkedAt: string;
  readonly ageMs: number;
  readonly cached: boolean;
  readonly dependencies: readonly DependencyReport[];
}

export interface DependencyCheck {
  readonly name: string;
  readonly required: boolean;
  run(): Promise<DependencyOutcome>;
}

/**
 * The Redis surface readiness needs. Narrower than `@upstash/redis`'s client so a
 * probe cannot reach for a command that writes, and so the checks are testable
 * without a client.
 */
export interface ReadinessRedis {
  ping(): Promise<string>;
  get(key: string): Promise<unknown>;
}

export function deriveStatus(reports: readonly DependencyReport[]): ReadinessStatus {
  if (reports.some((report) => report.required && report.state === "down")) return "unready";
  if (reports.some((report) => report.state === "down" || report.state === "degraded"))
    return "degraded";
  return "ready";
}
