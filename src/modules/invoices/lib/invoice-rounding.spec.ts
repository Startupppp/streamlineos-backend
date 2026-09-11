import { round2 } from "./invoice-helpers";
import { decimalFromNumber, roundDecimal } from "../../accounting/core/money.util";

/**
 * `round2` is the invoice module's only rounding primitive: it pins a line
 * amount, a per-line GST figure, the tax pool, the discount and the invoice
 * total. Every value it returns is rupees.
 *
 * The rule it must implement is half-up at two decimals — the rounding an
 * Indian GST tax invoice states and the rounding `money.util`'s `roundDecimal`
 * already performs for the ledger. `Math.round(n * 100) / 100` does not
 * implement it: `n * 100` is a double, and for a great many realistic amounts
 * the product lands a hair BELOW the .5 boundary, so `Math.round` goes down.
 * The error is therefore never noise that cancels — it is a systematic
 * understatement of output GST that is frozen into the invoice at issue by
 * trg_invoice_immutability and flows on into the GSTR-1 return.
 */
describe("round2 rounds money half-up at two decimals", () => {
  /** Half-up at 2dp via the ledger's exact BigInt arithmetic. */
  function exact(n: number): number {
    return Number(roundDecimal(decimalFromNumber(n), 2));
  }

  // Rupees. Each pair is (line amount, GST rate %) drawn from ordinary invoice
  // inputs, with the paisa the exact rule produces.
  const gstCases: ReadonlyArray<[number, number, number]> = [
    [10.75, 18, 1.94],
    [6.75, 18, 1.22],
    [5.75, 18, 1.04],
    [1.25, 18, 0.23],
    [0.7, 5, 0.04],
    [2.25, 12, 0.27],
  ];

  it.each(gstCases)("taxes Rs %s at %s%% as Rs %s", (amount, rate, expected) => {
    expect(round2(amount * (rate / 100))).toBe(expected);
  });

  it("rounds a qty x rate product up at the half-paisa boundary", () => {
    // Rupees: 1 x 1.005 is exactly one half-paisa; half-up owes the customer 1.01.
    expect(round2(1 * 1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(1.005)).toBe(1.01);
  });

  it("agrees with the ledger's own rounding on every case above", () => {
    for (const [amount, rate] of gstCases) {
      expect(round2(amount * (rate / 100))).toBe(exact(amount * (rate / 100)));
    }
  });

  it("leaves values that need no rounding alone", () => {
    expect(round2(0)).toBe(0);
    expect(round2(1000)).toBe(1000);
    expect(round2(1180.5)).toBe(1180.5);
    expect(round2(0.01)).toBe(0.01);
  });

  it("rounds down below the boundary and up above it", () => {
    expect(round2(1.004)).toBe(1);
    expect(round2(1.006)).toBe(1.01);
  });

  it("carries a negative amount away from zero, symmetrically", () => {
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-1.004)).toBe(-1);
  });
});
