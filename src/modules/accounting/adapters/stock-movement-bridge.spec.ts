import { invTxnTypeEnum } from "../../../db/schema/common/enums";
import { StockMovementBridgeService } from "./stock-movement-bridge.service";
import { AdapterRejection } from "./posting-command.types";
import {
  MOVEMENT_GL_TREATMENT,
  MOVEMENT_COUNTERPART_ROLES,
  type InvTxnType,
} from "./stock-movement-treatment";

/**
 * ACC-21. The ten stock-moving services that reached no ledger.
 *
 * The contract called it one hole. It is not: of the ten, six change what the
 * business owns and must post, one posts only when it goes wrong, and three
 * are correct to post nothing. Making all ten post would have been the
 * confident, wrong answer — a quarantine journal would move a balance sheet
 * for goods that never left the building.
 *
 * The value always comes from the stock rows the engine just wrote, never from
 * the caller. That is what makes ACC-09's reconciliation able to fire only on
 * a real defect, and it is asserted here rather than described.
 */

function bridgeWith(rows: Array<{ transaction_type: string; signed_minor: string }>) {
  const submit = jest.fn().mockResolvedValue({ journalId: "j1" });
  const execute = jest.fn().mockResolvedValue(rows);
  const bridge = new StockMovementBridgeService({ submit } as never);
  return { bridge, submit, tx: { execute } as never };
}

const POSTING = {
  kind: "adjustment" as const,
  documentId: "42",
  transactionIds: [1, 2],
  journalDate: "2026-09-10",
  memo: "Adjustment ADJ-1",
};

describe("the map from a movement to the ledger", () => {
  it("covers every movement type the database can store", () => {
    /*
      Exhaustive by construction — the map is keyed on the enum, so this is
      really asserting that the enum has not grown a member the map answers
      `undefined` for at runtime, which TypeScript cannot see across a
      migration that adds one.
    */
    const missing = invTxnTypeEnum.enumValues.filter((t) => !MOVEMENT_GL_TREATMENT[t]);
    expect(missing).toEqual([]);
    expect(invTxnTypeEnum.enumValues.length).toBeGreaterThan(15);
  });

  it("makes every 'posts nothing' answer say why", () => {
    /*
      The reason this file exists. "Posts nothing" read as an oversight for ten
      services at once, and the only defence is that the deliberate ones carry
      their argument next to them.
    */
    const thin = Object.entries(MOVEMENT_GL_TREATMENT)
      .filter(([, t]) => t.why.length < 60)
      .map(([type]) => type);
    expect(thin).toEqual([]);

    /*
      And there are several deliberate silences, not one. A keyword check on
      the prose was the first thing I wrote here and it was worthless — it
      tempts you to widen the pattern until it matches whatever you happened to
      write. The length floor plus the named cases below are the real
      assertions; this only pins that the silent set has not quietly emptied.
    */
    const silent = Object.entries(MOVEMENT_GL_TREATMENT).filter(([, t]) => t.kind === "none");
    expect(silent.length).toBeGreaterThan(3);
  });

  it("does not post a quarantine, because the business still owns the goods", () => {
    expect(MOVEMENT_GL_TREATMENT.QUARANTINE_IN.kind).toBe("none");
    expect(MOVEMENT_GL_TREATMENT.QUARANTINE_OUT.kind).toBe("none");
  });

  it("does not post opening stock, because the accountant's opening balance is its counterpart", () => {
    /*
      The one that would have been most tempting to post. An opening-stock
      import and an opening trial balance are two records of the same fact, and
      every real migration does both.
    */
    expect(MOVEMENT_GL_TREATMENT.OPENING_BALANCE.kind).toBe("none");
    expect(MOVEMENT_GL_TREATMENT.OPENING_BALANCE.why).toMatch(/opening trial balance/i);
  });

  it("does not post a reservation, which promises stock rather than moving it", () => {
    for (const type of ["RESERVATION_CREATE", "RESERVATION_RELEASE", "RESERVATION_CONSUME"] as const) {
      expect(MOVEMENT_GL_TREATMENT[type].kind).toBe("none");
    }
  });

  it("sends a receipt and a vendor return to the same account", () => {
    /*
      A return to a supplier reverses the receipt accrual, so it has to land
      where the receipt did. Crediting inventory against ap_control instead
      would leave GRNI holding an accrual for goods no longer held — the same
      class of defect as §2.2, arrived at from the other direction.
    */
    expect(MOVEMENT_GL_TREATMENT.GRN).toMatchObject({ role: "grni" });
    expect(MOVEMENT_GL_TREATMENT.VENDOR_RETURN).toMatchObject({ role: "grni" });
  });

  it("separates a write-off from a count variance", () => {
    /*
      A scrap is a decision somebody made; a count loss is a discovery. One
      account for both would make it impossible to ask how much stock was
      deliberately destroyed this period.
    */
    expect(MOVEMENT_GL_TREATMENT.SCRAP).toMatchObject({ role: "inventory_write_off" });
    expect(MOVEMENT_GL_TREATMENT.CYCLE_COUNT_LOSS).toMatchObject({ role: "inventory_adjustment" });
  });

  it("names only roles the chart can actually offer", () => {
    /* A tag the enum does not carry would fail at post time, per tenant. */
    const known = new Set(["inventory", "cogs", "grni", "inventory_write_off", "inventory_adjustment", "ap_control"]);
    for (const role of MOVEMENT_COUNTERPART_ROLES) expect(known.has(role)).toBe(true);
  });
});

describe("building the journal from the stock rows", () => {
  it("takes the value from the stock ledger, not from the caller", async () => {
    /*
      The property that makes ACC-09 meaningful. Nothing in the input carries
      an amount; the only numbers in the journal come from rows the engine
      wrote, so the two ledgers cannot disagree about a movement they both saw.
    */
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "ADJUSTMENT_OUT", signed_minor: "-5000" },
    ]);

    await bridge.post("org1", "u1", POSTING, tx);

    expect(Object.keys(POSTING)).not.toContain("amountMinor");
    const command = submit.mock.calls[0]![2];
    expect(command.lines).toEqual([
      expect.objectContaining({ accountTag: "inventory", creditMinor: 5000 }),
      expect.objectContaining({ accountTag: "inventory_adjustment", debitMinor: 5000 }),
    ]);
  });

  it("debits inventory when stock is found and credits it when stock is lost", async () => {
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "CYCLE_COUNT_GAIN", signed_minor: "1200" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "cycle_count" }, tx);

    expect(submit.mock.calls[0]![2].lines).toEqual([
      expect.objectContaining({ accountTag: "inventory", debitMinor: 1200 }),
      expect.objectContaining({ accountTag: "inventory_adjustment", creditMinor: 1200 }),
    ]);
  });

  it("posts nothing for a transfer that arrived intact", async () => {
    /*
      Both legs hit one inventory account, so a complete transfer nets to zero
      and there is no journal to write. No special case does this — it falls
      out of grouping by role, which is why it cannot be forgotten.
    */
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "TRANSFER_OUT", signed_minor: "-7500" },
      { transaction_type: "TRANSFER_IN", signed_minor: "7500" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "transfer" }, tx);

    expect(submit).not.toHaveBeenCalled();
  });

  it("posts exactly the shrinkage of a transfer that did not", async () => {
    /*
      Goods dispatched and not received are a real loss, and the difference is
      the only part that should reach the ledger.
    */
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "TRANSFER_OUT", signed_minor: "-7500" },
      { transaction_type: "TRANSFER_IN", signed_minor: "7000" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "transfer" }, tx);

    expect(submit.mock.calls[0]![2].lines).toEqual([
      expect.objectContaining({ accountTag: "inventory", creditMinor: 500 }),
      expect.objectContaining({ accountTag: "inventory_adjustment", debitMinor: 500 }),
    ]);
  });

  it("writes nothing at all for a document that only moved buckets", async () => {
    /*
      A quality hold costs its outflow leg, so these rows carry real value and
      an unconditional bridge would have written a write-off for goods sitting
      in the next aisle.
    */
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "QUARANTINE_IN", signed_minor: "-9900" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "quality_inspection" }, tx);

    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps a thousand-line count to one balanced pair", async () => {
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "CYCLE_COUNT_GAIN", signed_minor: "4000" },
      { transaction_type: "CYCLE_COUNT_LOSS", signed_minor: "-1000" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "cycle_count" }, tx);

    const lines = submit.mock.calls[0]![2].lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountTag: "inventory", debitMinor: 3000 });
  });

  it("splits a mixed document by role rather than merging it", async () => {
    /*
      An inspection that scraps some and returns the rest to stock touches two
      counterparts, and netting them into one would hide the write-off.
    */
    const { bridge, submit, tx } = bridgeWith([
      { transaction_type: "SCRAP", signed_minor: "-2000" },
      { transaction_type: "ADJUSTMENT_IN", signed_minor: "500" },
    ]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "quality_inspection" }, tx);

    const lines = submit.mock.calls[0]![2].lines;
    expect(lines).toHaveLength(4);
    expect(lines).toContainEqual(expect.objectContaining({ accountTag: "inventory_write_off", debitMinor: 2000 }));
    expect(lines).toContainEqual(expect.objectContaining({ accountTag: "inventory_adjustment", creditMinor: 500 }));
  });

  it("never queries when there are no movements", async () => {
    const { bridge, submit, tx } = bridgeWith([]);
    await bridge.post("org1", "u1", { ...POSTING, transactionIds: [] }, tx);
    expect(submit).not.toHaveBeenCalled();
    expect((tx as unknown as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
  });
});

describe("what the bridge refuses and what it lets through", () => {
  it("lets a warehouse run when the org never enabled accounting", async () => {
    const { bridge, tx } = bridgeWith([{ transaction_type: "SCRAP", signed_minor: "-100" }]);
    (bridge as never as { posting: { submit: jest.Mock } }).posting.submit.mockRejectedValue(
      new AdapterRejection("BOOK_NOT_ENABLED", "no book"),
    );

    await expect(bridge.post("org1", "u1", POSTING, tx)).resolves.toBeUndefined();
  });

  it("refuses the movement when the period is locked or a role is unmapped", async () => {
    /*
      Fail closed. A stock change the ledger will not accept must not happen,
      and because the post rides the caller's transaction the throw takes the
      movement with it.
    */
    for (const code of ["PERIOD_CLOSED", "UNKNOWN_ACCOUNT_TAG"] as const) {
      const { bridge, tx } = bridgeWith([{ transaction_type: "SCRAP", signed_minor: "-100" }]);
      (bridge as never as { posting: { submit: jest.Mock } }).posting.submit.mockRejectedValue(
        new AdapterRejection(code as never, code),
      );

      await expect(bridge.post("org1", "u1", POSTING, tx)).rejects.toThrow(code);
    }
  });

  it("keys the journal on the document, one purpose per kind", async () => {
    /*
      `stock_move:{id}:{kind}`. The ADR's double-post came from two writers
      into one id space picking different purposes for the same document; a
      closed set of kinds, one per document type, is what stops that here.
    */
    const { bridge, submit, tx } = bridgeWith([{ transaction_type: "SCRAP", signed_minor: "-100" }]);

    await bridge.post("org1", "u1", { ...POSTING, kind: "vendor_return", documentId: "9" }, tx);

    expect(submit.mock.calls[0]![2]).toMatchObject({
      sourceType: "stock_move",
      sourceId: "9",
      purpose: "vendor_return",
    });
  });

  it("posts on the caller's transaction, not on a new one", async () => {
    /*
      Passed explicitly rather than relying on the request interceptor's
      ambient transaction — §3.3/§4 of the contract. The atomicity has to be
      declared by this seam, not borrowed from whatever opened a transaction
      upstream.
    */
    const { bridge, submit, tx } = bridgeWith([{ transaction_type: "SCRAP", signed_minor: "-100" }]);

    await bridge.post("org1", "u1", POSTING, tx);

    expect(submit.mock.calls[0]![3]).toBe(tx);
  });
});
