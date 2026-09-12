import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INVENTORY_COUNTERS,
  createInventoryCounterRegistry,
  inventoryCounters,
} from "../inventory-counters";

/**
 * G6 — the properties that make a counter usable rather than decorative.
 *
 * The unit's bar is "a stock conflict is visible in logs or the existing metrics
 * path". That is easy to satisfy badly — a global counter that leaks memory, or
 * one that reports a total nobody can interpret across a deploy. These pin the
 * three things that would make it worse than nothing.
 */

describe("G6 inventory counters", () => {
  beforeEach(() => inventoryCounters.reset());

  it("counts per tenant, because a rate is only actionable if you know whose", () => {
    inventoryCounters.increment("org-a", "stock.command.conflict");
    inventoryCounters.increment("org-a", "stock.command.conflict");
    inventoryCounters.increment("org-b", "stock.command.conflict");

    expect(inventoryCounters.snapshotFor("org-a")["stock.command.conflict"]).toBe(2);
    expect(inventoryCounters.snapshotFor("org-b")["stock.command.conflict"]).toBe(1);
    expect(inventoryCounters.snapshot().totals["stock.command.conflict"]).toBe(3);
  });

  it("reports zero for a counter nothing has touched, rather than omitting it", () => {
    // A missing key and a zero are different facts, and a dashboard that has to
    // guess which it is shows neither.
    const snapshot = inventoryCounters.snapshotFor("org-quiet");
    for (const counter of INVENTORY_COUNTERS) {
      expect(snapshot[counter]).toBe(0);
    }
  });

  it("evicts the least recently used tenant instead of growing without bound", () => {
    // An unbounded map keyed by org id is a memory leak in a long-lived process
    // on a many-tenant platform. The cap is the point; so is saying it happened.
    let clock = 0;
    const registry = createInventoryCounterRegistry(() => (clock += 1));

    for (let i = 0; i < 500; i++) registry.increment(`org-${i}`, "stock.command.success");
    expect(registry.snapshot().tenants).toBe(500);
    expect(registry.snapshot().droppedTenants).toBe(0);

    // Touch org-0 so it is no longer the oldest, then overflow.
    registry.increment("org-0", "stock.command.success");
    registry.increment("org-overflow", "stock.command.success");

    const after = registry.snapshot();
    expect(after.tenants).toBe(500);
    expect(after.droppedTenants).toBe(1);
    // org-1 was the least recently touched, so it went; org-0 survived.
    expect(registry.snapshotFor("org-0")["stock.command.success"]).toBe(2);
    expect(registry.snapshotFor("org-1")["stock.command.success"]).toBe(0);
    expect(registry.snapshotFor("org-overflow")["stock.command.success"]).toBe(1);
  });

  it("is incremented where a conflict actually happens, not at the edge", () => {
    // The unit asks for a stock conflict to be *visible*. Asserting the call
    // site rather than mocking it is what stops the counter being deleted by a
    // future refactor of the idempotency claim while this spec stays green.
    const idempotency = readFileSync(
      join(__dirname, "..", "..", "stock-engine", "idempotency.ts"),
      "utf8",
    );
    expect(idempotency).toContain('inventoryCounters.increment(orgId, "stock.command.conflict")');
    expect(idempotency).toContain('inventoryCounters.increment(orgId, "stock.command.replayed")');
    expect(idempotency).toContain('inventoryCounters.increment(orgId, "stock.command.retry")');

    const apply = readFileSync(
      join(__dirname, "..", "..", "stock-engine", "movement-apply.service.ts"),
      "utf8",
    );
    expect(apply).toContain('inventoryCounters.increment(orgId, "stock.command.success")');
  });

  it("keeps the gauges out of the counters — they are queries, not tallies", () => {
    // Counting negative stock in-process would make a second, worse copy of a
    // number Postgres answers exactly, and the copy drifts across instances.
    const names = INVENTORY_COUNTERS as readonly string[];
    for (const gauge of [
      "stock.negative_levels",
      "reservation.age",
      "outbox.lag",
      "outbox.dead",
    ]) {
      expect(names).not.toContain(gauge);
    }
  });
});
