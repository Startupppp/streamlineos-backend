import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  buildGrainBudgets,
  resolveExitLines,
  reviveTransitExit,
  type ExitGrain,
  type StrandedDocumentLine,
} from "../lib/transit-exit-lines";

/**
 * R3, item 2 — how much may leave transit, decided from the document *and* the ledger.
 *
 * The bound matters more here than it looks. A transit location is per
 * **warehouse**, so every dispatch out of that warehouse parks its goods on the
 * same bin at a grain that names no document. A caller who over-states a line
 * therefore does not get an error about their own transfer: the engine finds the
 * stock, because it is somebody else's, and moves it.
 *
 * The bound is per stock grain rather than per line, and it subtracts what
 * earlier exits already took. `quantity - quantity_received` is a property of
 * the document that no exit ever changes, so a line-only bound recomputes the
 * same remainder for every command — and `runIdempotent` does not save it,
 * because that fences a retry of the same request, not a second request under a
 * fresh key.
 */
const DOCUMENT_LINES: StrandedDocumentLine[] = [
  {
    transferLineId: 1,
    productVariantId: 100,
    lotId: null,
    serialId: null,
    stranded: "5.0000",
  },
  {
    transferLineId: 2,
    productVariantId: 101,
    lotId: 9,
    serialId: null,
    stranded: "0.0000",
  },
];

const NOTHING_EXITED: ReadonlyArray<ExitGrain & { quantity: string }> = [];

const budgetsFor = (
  lines: ReadonlyArray<StrandedDocumentLine> = DOCUMENT_LINES,
  exited: ReadonlyArray<ExitGrain & { quantity: string }> = NOTHING_EXITED,
) => buildGrainBudgets(lines, exited);

describe("buildGrainBudgets", () => {
  it("pools lines that name the same stock grain", () => {
    // Two lines of one transfer against one (variant, lot, serial) share a
    // balance. Bounding them separately bounds each against stock the other is
    // also claiming.
    const budgets = buildGrainBudgets(
      [
        { transferLineId: 1, productVariantId: 100, lotId: null, serialId: null, stranded: "5.0000" },
        { transferLineId: 2, productVariantId: 100, lotId: null, serialId: null, stranded: "3.0000" },
      ],
      NOTHING_EXITED,
    );
    expect(budgets.get("100::")).toBe("8.0000");
  });

  it("subtracts what earlier exits already took off that grain", () => {
    const budgets = buildGrainBudgets(DOCUMENT_LINES, [
      { productVariantId: 100, lotId: null, serialId: null, quantity: "5.0000" },
    ]);
    expect(budgets.get("100::")).toBe("0.0000");
  });

  it("ignores a line that received more than it dispatched", () => {
    const budgets = buildGrainBudgets(
      [{ transferLineId: 1, productVariantId: 100, lotId: null, serialId: null, stranded: "-2.0000" }],
      NOTHING_EXITED,
    );
    expect(budgets.get("100::")).toBeUndefined();
  });
});

describe("resolveExitLines", () => {
  it("takes the whole stranded remainder when the caller names no lines", () => {
    // A transfer abandoned wholesale is one call, not one per line.
    expect(resolveExitLines(DOCUMENT_LINES, undefined, budgetsFor())).toEqual([
      {
        transferLineId: 1,
        productVariantId: 100,
        lotId: null,
        serialId: null,
        quantity: "5.0000",
      },
    ]);
  });

  it("skips lines that stranded nothing", () => {
    const out = resolveExitLines(DOCUMENT_LINES, undefined, budgetsFor());
    expect(out.map((l) => l.transferLineId)).not.toContain(2);
  });

  it("takes nothing at all once an earlier exit cleared the grain", () => {
    // The hole this closes: without the ledger term, a second command under a
    // fresh idempotency key posted the identical shortfall a second time.
    const budgets = budgetsFor(DOCUMENT_LINES, [
      { productVariantId: 100, lotId: null, serialId: null, quantity: "5.0000" },
    ]);
    expect(resolveExitLines(DOCUMENT_LINES, undefined, budgets)).toEqual([]);
  });

  it("takes only what an earlier partial exit left", () => {
    const budgets = budgetsFor(DOCUMENT_LINES, [
      { productVariantId: 100, lotId: null, serialId: null, quantity: "2.0000" },
    ]);
    expect(resolveExitLines(DOCUMENT_LINES, undefined, budgets)).toEqual([
      expect.objectContaining({ transferLineId: 1, quantity: "3.0000" }),
    ]);
  });

  it("accepts a partial quantity — half a pallet found, half written off", () => {
    expect(
      resolveExitLines(DOCUMENT_LINES, [{ transferLineId: 1, quantity: "2.0000" }], budgetsFor()),
    ).toEqual([expect.objectContaining({ transferLineId: 1, quantity: "2.0000" })]);
  });

  it("refuses more than the line actually stranded", () => {
    expect(() =>
      resolveExitLines(DOCUMENT_LINES, [{ transferLineId: 1, quantity: "6.0000" }], budgetsFor()),
    ).toThrow(BadRequestException);
  });

  it("refuses more than an earlier exit left, even though the document still says five", () => {
    const budgets = budgetsFor(DOCUMENT_LINES, [
      { productVariantId: 100, lotId: null, serialId: null, quantity: "4.0000" },
    ]);
    expect(() =>
      resolveExitLines(DOCUMENT_LINES, [{ transferLineId: 1, quantity: "5.0000" }], budgets),
    ).toThrow(BadRequestException);
  });

  it("refuses a line that stranded nothing, rather than posting a zero movement", () => {
    expect(() => resolveExitLines(DOCUMENT_LINES, [{ transferLineId: 2 }], budgetsFor())).toThrow(
      BadRequestException,
    );
  });

  it("refuses the same line named twice in one exit", () => {
    // Two halves of the bound are not the bound: 3 + 3 against a remainder of 5
    // passes line by line and takes six units off the bin.
    expect(() =>
      resolveExitLines(
        DOCUMENT_LINES,
        [
          { transferLineId: 1, quantity: "3.0000" },
          { transferLineId: 1, quantity: "3.0000" },
        ],
        budgetsFor(),
      ),
    ).toThrow(BadRequestException);
  });

  it("bounds two different lines of one grain against the balance they share", () => {
    const lines: StrandedDocumentLine[] = [
      { transferLineId: 1, productVariantId: 100, lotId: null, serialId: null, stranded: "5.0000" },
      { transferLineId: 2, productVariantId: 100, lotId: null, serialId: null, stranded: "5.0000" },
    ];
    // The grain holds 10, so 6 then 6 must fail on the second — the budget is
    // consumed as the request is walked.
    expect(() =>
      resolveExitLines(
        lines,
        [
          { transferLineId: 1, quantity: "6.0000" },
          { transferLineId: 2, quantity: "6.0000" },
        ],
        budgetsFor(lines),
      ),
    ).toThrow(BadRequestException);
  });

  it("refuses a line belonging to some other transfer", () => {
    expect(() => resolveExitLines(DOCUMENT_LINES, [{ transferLineId: 999 }], budgetsFor())).toThrow(
      NotFoundException,
    );
  });

  it("carries the grain from the document, never from the request", () => {
    // The request names a transfer line, not a (variant, lot, serial). Letting a
    // client choose the grain would let it move units of a lot the transfer never
    // dispatched, off a bin shared with every other transfer out of that warehouse.
    const lines: StrandedDocumentLine[] = [{ ...DOCUMENT_LINES[1]!, stranded: "4.0000" }];
    const [line] = resolveExitLines(lines, [{ transferLineId: 2 }], budgetsFor(lines));
    expect(line).toEqual({
      transferLineId: 2,
      productVariantId: 101,
      lotId: 9,
      serialId: null,
      quantity: "4.0000",
    });
  });
});

describe("reviveTransitExit", () => {
  it("rebuilds a replayed exit from JSON rather than casting to it", () => {
    // The stored response has been through `jsonb`, so nothing about its runtime
    // shape is guaranteed by the type it was written as.
    expect(
      reviveTransitExit({
        transferId: 12,
        disposition: "WRITE_OFF",
        transitLocationId: 3,
        lines: [{ transferLineId: 1, quantity: "5.0000" }],
        transactionIds: [77],
        transferStatus: "CANCELLED",
        strandedRemaining: "0.0000",
      }),
    ).toEqual({
      transferId: 12,
      disposition: "WRITE_OFF",
      transitLocationId: 3,
      lines: [{ transferLineId: 1, quantity: "5.0000" }],
      transactionIds: [77],
      transferStatus: "CANCELLED",
      strandedRemaining: "0.0000",
    });
  });

  it("falls back to RETURN_TO_SOURCE for anything that is not a write-off", () => {
    expect(reviveTransitExit({}).disposition).toBe("RETURN_TO_SOURCE");
    expect(reviveTransitExit(null).lines).toEqual([]);
  });
});
