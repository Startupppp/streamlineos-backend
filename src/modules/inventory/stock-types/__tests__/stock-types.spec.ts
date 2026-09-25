import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  assertCatchWeightLine,
  averagePieceWeight,
} from "../catch-weight";
import { availableQty, mulDec, subDec } from "../../stock-engine/decimal";
import { availableQtySql } from "../../stock-engine/available-sql";
import { levelKey } from "../../stock-engine/stock-level-locks";
import { EXPECTED_COMMITTED, EXPECTED_OUTGOING } from "../../stock-engine/projection-definitions";

describe("NEO-10 - catch-weight lines", () => {
  it("refuses a catch-weight line that does not say how many pieces", () => {
    // Nobody can pick it: the shelf holds bags, and the line states kilograms.
    expect(() =>
      assertCatchWeightLine("CATCH_WEIGHT", { quantity: "10.3500", quantityPieces: null }),
    ).toThrow(BadRequestException);
  });

  it("accepts a catch-weight line stating both", () => {
    expect(() =>
      assertCatchWeightLine("CATCH_WEIGHT", { quantity: "10.3500", quantityPieces: "2.0000" }),
    ).not.toThrow();
  });

  it("refuses a pieces line that states a different piece count from its quantity", () => {
    // Two contradictory statements of one fact. Guessing which the clerk meant is
    // how a delivery gets counted wrong twice.
    expect(() =>
      assertCatchWeightLine("PIECES", { quantity: "12.0000", quantityPieces: "10.0000" }),
    ).toThrow(/same number/);
  });

  it("leaves an ordinary pieces line alone", () => {
    expect(() =>
      assertCatchWeightLine("PIECES", { quantity: "12.0000", quantityPieces: null }),
    ).not.toThrow();
  });

  it("prices from the actual weight, not the piece count", () => {
    // The whole point. Two bags at 250 a kilo are 250 x 10.35, not 250 x 2, and a
    // system that cannot say that cannot invoice a butcher.
    expect(mulDec("250.0000", "10.3500")).toBe("2587.5000");
  });

  it("reports an average piece weight without enforcing one", () => {
    // Bags genuinely differ. A tolerance somebody would have to configure is a
    // setting that gets set once and then refuses real deliveries for a year.
    expect(averagePieceWeight({ quantity: "10.3500", quantityPieces: "2.0000" })).toBe("5.1750");
    expect(averagePieceWeight({ quantity: "10.3500", quantityPieces: null })).toBeNull();
  });

  it("walks the work order's own fixture without a float", () => {
    // Receive 2 bags, 10.35 kg. Sell 1 bag, 5.10 kg. 5.25 kg remains.
    const received = "10.3500";
    const sold = "5.1000";
    expect(subDec(received, sold)).toBe("5.2500");
  });
});

describe("NEO-11 - consigned stock is not ours", () => {
  const base = {
    on_hand: "10.0000",
    committed: "0",
    blocked_qty: "0",
    quality_hold_qty: "0",
    outgoing_qty: "0",
  };

  it("is never available to promise", () => {
    expect(availableQty({ ...base, ownership: "VENDOR" })).toBe("0.0000");
    expect(availableQty({ ...base, ownership: "CUSTOMER" })).toBe("0.0000");
  });

  it("leaves owned stock exactly as it was", () => {
    // The compatibility argument: a caller that has not been taught about
    // consignment gets the answer it had before.
    expect(availableQty({ ...base, ownership: "OWNED" })).toBe("10.0000");
    expect(availableQty(base)).toBe("10.0000");
  });

  it("gates in the SQL half too, so the two cannot drift", () => {
    const rendered = new PgDialect().sqlToQuery(availableQtySql("sl")).sql;
    expect(rendered).toContain("sl.ownership <> 'OWNED'");
  });

  it("is a distinct stock row from the owned stock at the same bin", () => {
    const owned = {
      productVariantId: 7, locationId: 3, lotId: null, serialId: null,
      handlingUnitId: null, ownership: "OWNED" as const,
    };
    expect(levelKey(owned)).not.toBe(levelKey({ ...owned, ownership: "VENDOR" }));
  });

  it("keeps the projections on owned stock only", () => {
    // Without this a single pick would empty the consigned row's outgoing_qty as
    // well as the owned one's - the defect projection-definitions.ts documents,
    // one grain deeper.
    const render = (sql: typeof EXPECTED_COMMITTED) => new PgDialect().sqlToQuery(sql).sql;
    expect(render(EXPECTED_COMMITTED)).toContain("sl.ownership = 'OWNED'");
    expect(render(EXPECTED_OUTGOING)).toContain("sl.ownership = 'OWNED'");
  });
});
