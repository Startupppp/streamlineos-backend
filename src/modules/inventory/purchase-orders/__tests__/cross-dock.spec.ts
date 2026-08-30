import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NEO-8 - the cross-dock path, asserted where it can be asserted without a
 * database.
 *
 * The claims worth pinning are structural rather than arithmetic:
 *
 *   * the legs are appended after every receipt, because
 *     `costFromMovementIndex` may only reference backwards;
 *   * a warehouse with no staging location is refused rather than defaulted;
 *   * no putaway task is raised for a cross-docked grain, and that is true by
 *     construction rather than by a flag - `readReceiptGrains` keeps only
 *     positive remainders at the receiving location, and these net to zero.
 *
 * The quantities themselves are the engine's, and the golden path (NEO-16)
 * exercises them against a real database.
 */
const POST_SERVICE = readFileSync(join(__dirname, "..", "grn-post.service.ts"), "utf8");
const GRAINS = readFileSync(
  join(__dirname, "..", "..", "putaway", "putaway-receipt-grains.ts"),
  "utf8",
);
const DESTINATION = readFileSync(
  join(__dirname, "..", "..", "putaway", "putaway-destination.ts"),
  "utf8",
);

describe("NEO-8 - cross-dock", () => {
  it("appends the legs after every receipt, never interleaved", () => {
    // A leg written before its own receipt would inherit a cost the engine has
    // not computed yet, which under FIFO is a different number from the right one.
    const collect = POST_SERVICE.indexOf("crossDockLegs.push");
    const append = POST_SERVICE.indexOf("movements.push(...crossDockLegs)");
    expect(collect).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(collect);
  });

  it("takes the inbound leg's cost from the receipt rather than estimating it", () => {
    expect(POST_SERVICE).toContain("costFromMovementIndex: receiptIndex");
  });

  it("refuses a cross-dock in a warehouse with no staging location", () => {
    // Putting somebody's goods in a bin nobody chose is worse than telling them
    // the building is not set up for this.
    expect(POST_SERVICE).toContain("no outbound staging location");
    expect(DESTINATION).toContain("findCrossDockStagingLocation");
    expect(DESTINATION).toContain("location_type = 'SHIPPING'");
  });

  it("reserves the units to the order that pulled them across the dock", () => {
    // Otherwise they sit at a pickable staging location as ordinary free stock
    // and the next order to ask is offered them.
    expect(POST_SERVICE).toContain("createReservationInTx");
    expect(POST_SERVICE).toContain("inv_sales_order");
  });

  it("raises no putaway task for them, by construction rather than by a flag", () => {
    // The grain query keeps only positive remainders at the receiving location.
    // A cross-docked grain has a receipt and an equal transfer out, so it nets to
    // zero and never appears - no cross-dock branch is needed here, and adding
    // one would be a second place for the rule to live.
    expect(GRAINS).toContain("HAVING SUM(t.quantity_change) > 0");
    expect(GRAINS).toContain("t.location_id = ${fromLocationId}");
    expect(GRAINS).not.toMatch(/cross[_ ]?dock/i);
  });
});
