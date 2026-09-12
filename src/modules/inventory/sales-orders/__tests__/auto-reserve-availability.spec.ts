/**
 * A1/A2 — the auto-reserve allocator promises only stock that is actually free.
 *
 * `findAvailableLotForLine` carried a private four-term copy of the availability
 * formula: it never selected `outgoing_qty` and knew nothing of `is_sellable`.
 * So the allocator on sales-order confirm would promise units already picked
 * onto the packing bench, and units parked at a warehouse's TRANSIT location
 * while they sat on a lorry.
 *
 * Reserving transit stock was the worse of the two. The transfer's completion
 * later issues those units out of transit, `on_hand` reaches zero while
 * `committed` stays behind, and availability at that grain is negative from
 * then on — with reconciliation reporting no drift at all, because the
 * reservation genuinely is ACTIVE. The safety net agrees with the corruption.
 *
 * Found by review; kept because a private copy of this formula is the single
 * defect this module keeps regrowing.
 */
import { SoLifecycleService } from "../so-lifecycle.service";

type Level = {
  id: number;
  locationId: number;
  lotId: number | null;
  onHand: string;
  committed: string;
  blockedQty: string;
  qualityHoldQty: string;
  outgoingQty: string;
  location: { id: number; warehouseId: number; isSellable: boolean };
};

function serviceWithLevels(levels: Level[]): SoLifecycleService {
  const db = {
    query: {
      invStockLevels: { findMany: async () => levels },
      invLots: { findMany: async () => [] },
    },
  };
  return new SoLifecycleService(
    db as never, null as never, null as never, null as never,
    null as never, null as never, null as never, null as never,
  );
}

const TRANSIT_LOCATION = 900;
const SHELF_LOCATION = 10;

describe("SO auto-reserve availability", () => {
  it("must not allocate stock parked at a non-sellable TRANSIT location", async () => {
    const svc = serviceWithLevels([
      {
        id: 1, locationId: TRANSIT_LOCATION, lotId: null,
        onHand: "100.0000", committed: "0.0000",
        blockedQty: "0.0000", qualityHoldQty: "0.0000", outgoingQty: "0.0000",
        location: { id: TRANSIT_LOCATION, warehouseId: 1, isSellable: false },
      },
    ]);

    const chosen = await svc.findAvailableLotForLine(
      "org-1", 42, 1, "10.0000", "FIFO", "WARN",
    );

    // 100 units are in a van between two warehouses. Nothing is sellable.
    expect(chosen).toBeNull();
  });

  it("must not allocate stock already picked onto the packing bench", async () => {
    const svc = serviceWithLevels([
      {
        id: 2, locationId: SHELF_LOCATION, lotId: null,
        onHand: "100.0000", committed: "0.0000",
        blockedQty: "0.0000", qualityHoldQty: "0.0000",
        // Picked, covered by no reservation. availableQty() -> 0.
        outgoingQty: "100.0000",
        location: { id: SHELF_LOCATION, warehouseId: 1, isSellable: true },
      },
    ]);

    const chosen = await svc.findAvailableLotForLine(
      "org-1", 42, 1, "10.0000", "FIFO", "WARN",
    );

    expect(chosen).toBeNull();
  });
});

/**
 * The repair must not zero a correct `outgoing_qty`.
 *
 * `EXPECTED_OUTGOING` enumerates the sales-order statuses whose picked units are
 * still on the bench. `PARTIALLY_SHIPPED` is a live status and was missing, so
 * for a part-shipped order the check expected 0, reported the true remainder as
 * drift, and the repair wrote 0 over it — raising ATP by the quantity still
 * sitting in the tote. The list is enumerated positively so a status added later
 * defaults to "gone" rather than silently inflating the bucket, which is exactly
 * why it needs a test rather than a convention.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the outgoing_qty status list", () => {
  it("treats every pre-invoice SO status as in-flight", () => {
    const source = readFileSync(
      join(__dirname, "../../stock-engine/projection-definitions.ts"),
      "utf8",
    );
    const list = /so\.status IN \(([^)]*)\)/.exec(source)?.[1] ?? "";

    // Statuses in which units are picked and have not all left the building.
    for (const status of ["PICKED", "PACKED", "PARTIALLY_SHIPPED"]) {
      expect(list).toContain(status);
    }
  });
});
