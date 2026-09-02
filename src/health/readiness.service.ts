import type { ReadinessConfig } from "./readiness.config";
import {
  deriveStatus,
  type DependencyCheck,
  type DependencyOutcome,
  type DependencyReport,
  type ReadinessSnapshot,
} from "./readiness.types";

interface CachedSnapshot {
  readonly snapshot: ReadinessSnapshot;
  readonly at: number;
}

/**
 * Dependency-aware readiness that cannot amplify the outage it reports.
 *
 * A probe endpoint is hit hardest exactly when its dependencies are struggling:
 * orchestrators shorten intervals on failure and every replica probes at once, so
 * a naive endpoint turns one slow database into a saturated one. Two properties
 * prevent that, and both are asserted by spec:
 *
 * - **Cached.** One evaluation per `cacheTtlMs` window, regardless of probe rate.
 * - **Single-flight.** Probes arriving while an evaluation is in flight join it
 *   instead of starting their own; N concurrent probes still cost one fanout.
 *
 * Each check is also bounded by `checkTimeoutMs`, so a dependency that hangs
 * reports `down` on a deadline rather than holding the probe — and the caller —
 * open for as long as the dependency's own timeout.
 */
export class ReadinessService {
  private cached: CachedSnapshot | null = null;
  private inFlight: Promise<ReadinessSnapshot> | null = null;

  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly config: ReadinessConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  read(): Promise<ReadinessSnapshot> {
    const at = this.now();
    const cached = this.cached;
    if (cached !== null && at - cached.at < this.config.cacheTtlMs)
      return Promise.resolve({ ...cached.snapshot, ageMs: at - cached.at, cached: true });

    const existing = this.inFlight;
    if (existing !== null) return existing;

    const run = this.evaluate();
    this.inFlight = run;
    return run;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async evaluate(): Promise<ReadinessSnapshot> {
    const startedAt = this.now();
    try {
      const dependencies = await Promise.all(this.checks.map((check) => this.runBounded(check)));
      const snapshot: ReadinessSnapshot = {
        status: deriveStatus(dependencies),
        checkedAt: new Date(startedAt).toISOString(),
        ageMs: 0,
        cached: false,
        dependencies,
      };
      this.cached = { snapshot, at: startedAt };
      return snapshot;
    } finally {
      this.inFlight = null;
    }
  }

  private async runBounded(check: DependencyCheck): Promise<DependencyReport> {
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<DependencyOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            state: "down",
            detail: `check exceeded the ${String(this.config.checkTimeoutMs)}ms readiness budget`,
          }),
        this.config.checkTimeoutMs,
      );
    });

    try {
      const outcome = await Promise.race([check.run(), deadline]);
      return this.toReport(check, outcome, startedAt);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.toReport(check, { state: "down", detail }, startedAt);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private toReport(
    check: DependencyCheck,
    outcome: DependencyOutcome,
    startedAt: number,
  ): DependencyReport {
    return {
      name: check.name,
      required: check.required,
      state: outcome.state,
      latencyMs: Math.max(0, this.now() - startedAt),
      detail: outcome.detail ?? null,
    };
  }
}
