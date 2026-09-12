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
/**
 * The post path is three files: `grn-post.service.ts` holds the surface and the
 * transaction boundary, `lib/grn-post-tx.ts` the body of `postInTx`, and
 * `lib/grn-post-movements.ts` the movement shapes and the cross-dock legs.
 * Read all three, and assert below that the service still delegates - a
 * source-text spec left pointing at the file the code MOVED OUT OF passes
 * vacuously, which is how this spec failed when `postInTx` was extracted.
 */
const POST_SERVICE = readFileSync(join(__dirname, "..", "grn-post.service.ts"), "utf8");
const POST_TX = readFileSync(join(__dirname, "..", "lib", "grn-post-tx.ts"), "utf8");
const POST_MOVEMENTS = readFileSync(
  join(__dirname, "..", "lib", "grn-post-movements.ts"),
  "utf8",
);
const POST_PATH = [POST_SERVICE, POST_TX, POST_MOVEMENTS].join("\n");
const GRAINS = readFileSync(
  join(__dirname, "..", "..", "putaway", "putaway-receipt-grains.ts"),
  "utf8",
);
const DESTINATION = readFileSync(
  join(__dirname, "..", "..", "putaway", "putaway-destination.ts"),
  "utf8",
);

describe("NEO-8 - cross-dock", () => {
  it("reads the file the post path actually lives in", () => {
    // The anti-vacuity floor for the `POST_PATH` assertions below.
    expect(POST_SERVICE).toContain('from "./lib/grn-post-tx"');
    expect(POST_TX).toContain("export async function postInTx(");
    expect(POST_MOVEMENTS).toContain("export function buildCrossDockLegs(");
  });

  it("appends the legs after every receipt, never interleaved", () => {
    // A leg written before its own receipt would inherit a cost the engine has
    // not computed yet, which under FIFO is a different number from the right one.
    const collect = POST_TX.indexOf("crossDockLegs.push");
    const append = POST_TX.indexOf("movements.push(...crossDockLegs)");
    expect(collect).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(collect);
  });

  it("takes the inbound leg's cost from the receipt rather than estimating it", () => {
    expect(POST_MOVEMENTS).toContain("costFromMovementIndex: receiptIndex");
  });

  it("refuses a cross-dock in a warehouse with no staging location", () => {
    // Putting somebody's goods in a bin nobody chose is worse than telling them
    // the building is not set up for this.
    expect(POST_PATH).toContain("no outbound staging location");
    expect(DESTINATION).toContain("findCrossDockStagingLocation");
    expect(DESTINATION).toContain("location_type = 'SHIPPING'");
  });

  it("reserves the units to the order that pulled them across the dock", () => {
    // Otherwise they sit at a pickable staging location as ordinary free stock
    // and the next order to ask is offered them.
    expect(POST_PATH).toContain("createReservationInTx");
    expect(POST_PATH).toContain("inv_sales_order");
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
