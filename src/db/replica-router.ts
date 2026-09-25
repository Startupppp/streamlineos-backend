import { isReserved, type WorkClass } from "../common/admission/work-class";
import { NullReplicaHealthProbe, type ReplicaHealthProbe } from "./replica-lag-probe";

export type ReadStrategy = "primary-required" | "replica-safe";

/**
 * Thrown when a replica-safe work class is routed but the replica is configured and faulted.
 *
 * Falling back to the primary is refused deliberately: a silent fall-back would allow
 * stale-tolerant projections (analytics, search freshness) to compete for primary capacity
 * alongside correctness-sensitive traffic. Shedding is the declared behaviour per the
 * degradation matrix (ticket 31, read-replica row).
 */
export class ReplicaShedError extends Error {
  readonly workClass: WorkClass;

  constructor(wc: WorkClass) {
    super(
      `replica-safe work class "${wc}" cannot be served: replica is faulted and falling back ` +
        "to primary is refused to protect correctness-sensitive primary capacity",
    );
    this.name = "ReplicaShedError";
    this.workClass = wc;
  }
}

/**
 * Returns the read strategy for a given work class.
 *
 * - All reserved classes (authentication, billing-ledger, payroll-posting, etc.) are
 *   primary-required: correctness demands reading the latest committed state.
 * - analytics-refresh and search-freshness are replica-safe: they produce eventually-consistent
 *   projections and can tolerate bounded lag.
 * - All other sheddable classes are primary-required: they either write, have read-after-write
 *   requirements, or power user-visible reads where stale data is incorrect.
 */
export function routingStrategyFor(wc: WorkClass): ReadStrategy {
  if (isReserved(wc)) return "primary-required";
  if (wc === "analytics-refresh" || wc === "search-freshness") return "replica-safe";
  return "primary-required";
}

/**
 * An observable handle for a connection pool.  The `id` field is the observable surface
 * used in tests to assert which pool received a routing decision.
 */
export interface PoolHandle {
  readonly id: string;
  readonly connectionString: string;
}

/**
 * Routes reads between a primary and an optional read replica.
 *
 * Design invariant: the primary is always reachable.  The replica is optional.
 *
 * Call `route()` when you do not need explicit fault control (production code).
 * Call `routeWithFaultAwareness()` when you need to inject fault state (tests, health-check loops).
 */
export class ReplicaRouter {
  private readonly healthProbe: ReplicaHealthProbe;

  constructor(
    private readonly primary: PoolHandle,
    private readonly replica: PoolHandle | null,
    healthProbe?: ReplicaHealthProbe,
  ) {
    this.healthProbe = healthProbe ?? new NullReplicaHealthProbe();
  }

  /**
   * Routes a read using the injected health probe to determine replica health.
   *
   * When no replica is configured, replica-safe classes fall through to primary — this is
   * not a fault condition, merely an unconfigured deployment.
   *
   * When a replica IS configured but faulted (probe returns false), throws `ReplicaShedError`
   * to prevent stale-tolerant projections from competing for primary capacity.
   * Use `routeWithFallback` when silent fallback to primary is acceptable.
   */
  async route(wc: WorkClass): Promise<PoolHandle> {
    const isHealthy = await this.healthProbe.probe();
    return this.routeWithFaultAwareness(wc, isHealthy);
  }

  /**
   * Routes a read with fallback to primary when the replica is faulted, rather than shedding.
   *
   * Use this for lower-priority background work where completing on the primary is better
   * than failing. For analytics and search-index reads where primary capacity is precious,
   * prefer `route()` / `routeWithFaultAwareness()` with explicit shedding.
   */
  routeWithFallback(wc: WorkClass, isReplicaHealthy: boolean): PoolHandle {
    const strategy = routingStrategyFor(wc);
    if (strategy === "primary-required") return this.primary;
    if (this.replica === null) return this.primary;
    if (!isReplicaHealthy) return this.primary;
    return this.replica;
  }

  /**
   * Routes a read with explicit control over replica health.
   *
   * `isReplicaHealthy` is injected rather than detected here so that:
   * 1. Tests can control fault state without a real network.
   * 2. Production code can pass the result of an external health-check.
   *
   * When the replica IS configured AND the strategy is replica-safe AND the replica is
   * NOT healthy, this throws `ReplicaShedError`.  The caller must treat this as a 503
   * and not silently retry against the primary.
   */
  routeWithFaultAwareness(wc: WorkClass, isReplicaHealthy: boolean): PoolHandle {
    const strategy = routingStrategyFor(wc);

    if (strategy === "primary-required") return this.primary;

    if (this.replica === null) return this.primary;

    if (!isReplicaHealthy) throw new ReplicaShedError(wc);

    return this.replica;
  }
}
