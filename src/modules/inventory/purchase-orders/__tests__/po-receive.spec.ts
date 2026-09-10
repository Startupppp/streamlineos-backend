import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("GRN receive — over-receipt tolerance", () => {
  function maxAllowed(quantity: string, received: string, tolerancePct: string): number {
    const remaining = parseFloat(quantity) - parseFloat(received);
    return remaining * (1 + parseFloat(tolerancePct) / 100);
  }

  function isOverReceipt(qty: number, max: number): boolean {
    return qty > max + 0.0001;
  }

  it("allows receipt at exactly the tolerance boundary", () => {
    const max = maxAllowed("100", "0", "10");
    expect(isOverReceipt(110, max)).toBe(false);
  });

  it("allows receipt fractionally under the tolerance boundary", () => {
    const max = maxAllowed("100", "0", "10");
    expect(isOverReceipt(109.9999, max)).toBe(false);
  });

  it("rejects receipt a fraction above the tolerance boundary", () => {
    const max = maxAllowed("100", "0", "10");
    expect(isOverReceipt(110.0002, max)).toBe(true);
  });

  it("rejects receipt significantly above tolerance", () => {
    const max = maxAllowed("100", "0", "5");
    expect(isOverReceipt(120, max)).toBe(true);
  });

  it("accounts for already-received quantity in remaining", () => {
    const max = maxAllowed("100", "60", "10");
    expect(max).toBeCloseTo(44, 5);
    expect(isOverReceipt(44, max)).toBe(false);
    expect(isOverReceipt(44.001, max)).toBe(true);
  });

  it("tolerance of 0% means exact quantity only", () => {
    const max = maxAllowed("50", "0", "0");
    expect(isOverReceipt(50, max)).toBe(false);
    expect(isOverReceipt(50.001, max)).toBe(true);
  });

  it("tolerance of 100% doubles the allowed receipt", () => {
    const max = maxAllowed("100", "0", "100");
    expect(isOverReceipt(200, max)).toBe(false);
    expect(isOverReceipt(200.001, max)).toBe(true);
  });

  it("when fully received already remaining is 0, any qty over 0.0001 is rejected", () => {
    const max = maxAllowed("100", "100", "10");
    expect(max).toBe(0);
    expect(isOverReceipt(0, max)).toBe(false);
    expect(isOverReceipt(0.001, max)).toBe(true);
  });
});

describe("GRN receive — serial count validation", () => {
  function validateSerialCount(qty: number, serialNumbers: string[]): string | null {
    if (serialNumbers.length !== qty) {
      return `SERIAL-tracked product requires ${qty} serial numbers, got ${serialNumbers.length}`;
    }
    return null;
  }

  it("passes when serial count matches quantity", () => {
    expect(validateSerialCount(3, ["SN-001", "SN-002", "SN-003"])).toBeNull();
  });

  it("fails when fewer serials than quantity", () => {
    const err = validateSerialCount(3, ["SN-001"]);
    expect(err).toMatch(/requires 3/);
    expect(err).toMatch(/got 1/);
  });

  it("fails when more serials than quantity", () => {
    const err = validateSerialCount(2, ["SN-001", "SN-002", "SN-003"]);
    expect(err).toMatch(/requires 2/);
    expect(err).toMatch(/got 3/);
  });

  it("passes for quantity of 1 with one serial", () => {
    expect(validateSerialCount(1, ["SN-001"])).toBeNull();
  });

  it("fails when no serials provided for serial-tracked product", () => {
    const err = validateSerialCount(5, []);
    expect(err).toMatch(/requires 5/);
    expect(err).toMatch(/got 0/);
  });
});

describe("GRN idempotency — engine call deduplication", () => {
  function buildEngineResult(idempotencyKey: string, memo: Map<string, unknown>, fn: () => unknown) {
    if (memo.has(idempotencyKey)) return memo.get(idempotencyKey);
    const result = fn();
    memo.set(idempotencyKey, result);
    return result;
  }

  it("replays same result for duplicate idempotency key", () => {
    const memo = new Map<string, unknown>();
    let callCount = 0;
    const fn = () => { callCount++; return { txId: 42 }; };

    const r1 = buildEngineResult("key-abc", memo, fn);
    const r2 = buildEngineResult("key-abc", memo, fn);

    expect(r1).toEqual({ txId: 42 });
    expect(r2).toEqual({ txId: 42 });
    expect(callCount).toBe(1);
  });

  it("executes separately for different idempotency keys", () => {
    const memo = new Map<string, unknown>();
    let callCount = 0;
    const fn = () => { callCount++; return { txId: callCount }; };

    const r1 = buildEngineResult("key-1", memo, fn);
    const r2 = buildEngineResult("key-2", memo, fn);

    expect(r1).toEqual({ txId: 1 });
    expect(r2).toEqual({ txId: 2 });
    expect(callCount).toBe(2);
  });
});

/*
 * The one-step receive and the two-step post are two ways into the same
 * terminal state, and they disagreed.
 *
 * `POST /inventory/purchase-orders/:poId/receive` writes the stock movements
 * and the receipt journal itself, then inserted the GRN row without a status —
 * so the column default put it at DRAFT while the goods were already in the
 * building. `GrnPostingService.postInTx` refuses only POSTED and CANCELLED, so
 * that DRAFT row stayed postable: the workbench kept offering "Post to stock"
 * on a delivery that had landed, and taking it moved the same goods a second
 * time and posted a second journal entry.
 *
 * Asserted across BOTH files on purpose. Either half alone reads as correct —
 * the defect only exists in the relationship between what one writes and what
 * the other refuses, so a test that reads one file could never have caught it.
 */
describe("a receipt that posted its own stock cannot be posted again", () => {
  const receiveSrc = readFileSync(join(__dirname, "..", "grn-receive.service.ts"), "utf8");
  const postSrc = readFileSync(join(__dirname, "..", "grn-post.service.ts"), "utf8");

  /** The statuses `postInTx` turns away, read from its own guards. */
  function refusedByPost(): string[] {
    const guards = postSrc.matchAll(/locked\.status === "([A-Z_]+)"/g);
    return [...guards].map((m) => m[1]);
  }

  /** The `.values({...})` object of the receive path's GRN insert. */
  function receiveInsertValues(): string {
    const at = receiveSrc.indexOf(".insert(invGrns)");
    expect(at).toBeGreaterThan(-1);
    const open = receiveSrc.indexOf("{", receiveSrc.indexOf(".values(", at));
    let depth = 0;
    for (let i = open; i < receiveSrc.length; i++) {
      if (receiveSrc[i] === "{") depth++;
      else if (receiveSrc[i] === "}" && --depth === 0) return receiveSrc.slice(open, i + 1);
    }
    return "";
  }

  it("reads both sides, so the agreement below is not vacuous", () => {
    // A broken regex or a moved insert would otherwise make every case pass.
    expect(refusedByPost()).toEqual(expect.arrayContaining(["POSTED", "CANCELLED"]));
    expect(receiveInsertValues()).toContain("grnNumber");
  });

  it("stamps a status rather than leaving the row on the column default", () => {
    expect(receiveInsertValues()).toMatch(/status:\s*"[A-Z_]+"/);
  });

  it("stamps one the post path refuses, which is the whole point", () => {
    const stamped = /status:\s*"([A-Z_]+)"/.exec(receiveInsertValues())?.[1];
    expect(stamped).toBeDefined();
    expect(refusedByPost()).toContain(stamped);
  });

  it("records who posted it and when, like the two-step path does", () => {
    // grn-post.service.ts sets status, postedBy and postedAt together; a
    // receipt that is POSTED with a null posted_at is not a readable record.
    const values = receiveInsertValues();
    expect(values).toContain("postedBy");
    expect(values).toContain("postedAt");
  });
});
