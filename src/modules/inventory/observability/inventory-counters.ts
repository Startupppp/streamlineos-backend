/**
 * G6 — the counters, and why they are counters rather than a metrics library.
 *
 * `prom-client` is not installed and OpenTelemetry metrics are not wired here;
 * what exists is structured logging (`common/observability/`) and a hand-rolled
 * health controller. Adding a metrics stack to make this unit look finished
 * would be adding an operational dependency nobody has asked to run, and the
 * PRD's requirement is that a stock conflict be *visible*, not that it arrive in
 * any particular format.
 *
 * So: an in-process counter registry, snapshotted onto an operator endpoint and
 * logged on a cadence. It is honest about its limits — a counter here is
 * per-process and resets on deploy, which is fine for the rates it measures
 * (success vs conflict vs retry over a window) and useless for a total. Anything
 * that needs to survive a restart is derived from the database instead, in
 * `InventoryMetricsService`, because the database already knows.
 *
 * The split is the design, not an accident of what was easy:
 *
 *   * **Counters** for things that *happen* and leave no row of their own — a
 *     command conflicted, an idempotency key replayed, an AI call was refused
 *     credit. Nothing in the schema records these, so counting them in-process
 *     is the only way to see them at all.
 *   * **Gauges** for things that *are* — negative stock, reservation age,
 *     outbox lag, dead letters. These are queries. Counting them in-process
 *     would make a second, worse copy of a number the database can answer
 *     exactly, and the copy would drift the moment a second instance ran.
 */

/** Every counter this module knows how to increment. Adding one is a deliberate act. */
export const INVENTORY_COUNTERS = [
  // Stock command outcomes — the rate that matters is conflict ÷ (success + conflict).
  "stock.command.success",
  "stock.command.conflict",
  "stock.command.retry",
  "stock.command.replayed",
  // A movement the engine refused because it would have driven a bucket negative.
  "stock.negative_refused",
  // Ledger-to-projection reconciliation, when the recon report runs.
  "recon.failure",
  // Imports.
  "import.row.error",
  "import.resumed",
  // AI, through the gateway.
  "ai.call.success",
  "ai.call.failure",
  "ai.credit.refused",
  "ai.grounding.failure",
  // Statutory adapters (E5) — a rehearsal and a filing are counted apart.
  "compliance.registered.stub",
  "compliance.registered.live",
  "compliance.failed",
] as const;

export type InventoryCounter = (typeof INVENTORY_COUNTERS)[number];

/**
 * A per-process, per-tenant counter.
 *
 * Tenant-scoped because "conflicts are up" is only actionable if you know whose,
 * and because one noisy tenant otherwise hides every other tenant's silence.
 * Bounded: an unbounded map keyed by org id is a memory leak on a platform with
 * many tenants and a long-lived process, so the map is capped and the cap is
 * itself observable — a dropped tenant is worse than a missing metric only if
 * nobody knows it was dropped.
 */
const MAX_TRACKED_TENANTS = 500;

interface CounterState {
  readonly counts: Map<InventoryCounter, number>;
  lastTouchedMs: number;
}

class InventoryCounterRegistry {
  private readonly byOrg = new Map<string, CounterState>();
  private droppedTenants = 0;
  /** Wall-clock is injected so a test can assert eviction without sleeping. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  increment(orgId: string, counter: InventoryCounter, by = 1): void {
    let state = this.byOrg.get(orgId);
    if (!state) {
      if (this.byOrg.size >= MAX_TRACKED_TENANTS) {
        this.evictOldest();
      }
      state = { counts: new Map(), lastTouchedMs: this.now() };
      this.byOrg.set(orgId, state);
    }
    state.lastTouchedMs = this.now();
    state.counts.set(counter, (state.counts.get(counter) ?? 0) + by);
  }

  /** The least recently touched tenant, which is the one whose numbers matter least. */
  private evictOldest(): void {
    let oldestOrg: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [orgId, state] of this.byOrg) {
      if (state.lastTouchedMs < oldestAt) {
        oldestAt = state.lastTouchedMs;
        oldestOrg = orgId;
      }
    }
    if (oldestOrg !== null) {
      this.byOrg.delete(oldestOrg);
      this.droppedTenants += 1;
    }
  }

  snapshotFor(orgId: string): Record<string, number> {
    const state = this.byOrg.get(orgId);
    const out: Record<string, number> = {};
    for (const counter of INVENTORY_COUNTERS) out[counter] = state?.counts.get(counter) ?? 0;
    return out;
  }

  /** Everything, for an operator endpoint. Includes the eviction count deliberately. */
  snapshot(): { tenants: number; droppedTenants: number; totals: Record<string, number> } {
    const totals: Record<string, number> = {};
    for (const counter of INVENTORY_COUNTERS) totals[counter] = 0;
    for (const state of this.byOrg.values()) {
      for (const [counter, value] of state.counts) {
        totals[counter] = (totals[counter] ?? 0) + value;
      }
    }
    return { tenants: this.byOrg.size, droppedTenants: this.droppedTenants, totals };
  }

  /** Test seam. Never called at runtime. */
  reset(): void {
    this.byOrg.clear();
    this.droppedTenants = 0;
  }
}

/**
 * The one registry.
 *
 * A module-level singleton rather than an injectable, because the places that
 * need to increment — the engine's movement body, the idempotency claim, the
 * outbox publisher — are functions rather than services, and threading a
 * provider through them would mean changing signatures across the engine to
 * carry a metric. That is a worse trade than a module-level counter whose only
 * state is numbers.
 */
export const inventoryCounters = new InventoryCounterRegistry();

/** Exported for tests that need to control the clock. */
export function createInventoryCounterRegistry(now: () => number) {
  return new InventoryCounterRegistry(now);
}
