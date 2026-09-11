/**
 * The regression net for the P1 at payment-webhook-receiver.service.ts:290.
 *
 * The finance bridge was handed `String(paymentEntity.amount / 100)` while the provider's
 * OWN currency code was passed through untouched. 100 is a two-decimal assumption, and the
 * receiver is provider-neutral by construction (`providerKey` is a route parameter and
 * payment-provider-catalog.ts already lists Stripe with USD/EUR/GBP/AUD/CAD). Providers
 * report JPY, KRW and VND in whole units and KWD, BHD and JOD in thousandths, so a
 * ¥100,000 capture was recorded as ¥1,000 — a 100x understatement posted straight to the
 * general ledger — and a KWD 1.234 capture as KWD 12.34.
 *
 * The DTO was the other half: `paymentWebhookPaymentSchema.amount` was `z.number()` with
 * no `.int()`, so a provider adapter emitting major units would have been accepted and
 * silently rounded into an integer column.
 */
import { paymentWebhookPaymentSchema } from "./dto/webhook.schemas";
import {
  DEFAULT_MINOR_UNIT_EXPONENT,
  minorUnitExponent,
  minorUnitsToDecimalString,
} from "./currency-minor-units";

describe("minor-unit exponents come from the currency, not from a constant 100", () => {
  it("two-decimal currencies are the default, including the ones we ship", () => {
    expect(minorUnitExponent("INR")).toBe(2);
    expect(minorUnitExponent("USD")).toBe(2);
    expect(minorUnitExponent("EUR")).toBe(2);
    expect(DEFAULT_MINOR_UNIT_EXPONENT).toBe(2);
  });

  it("zero-decimal currencies have no minor unit at all", () => {
    for (const code of ["JPY", "KRW", "VND", "ISK", "CLP", "XOF"]) {
      expect(minorUnitExponent(code)).toBe(0);
    }
  });

  it("three-decimal currencies divide by 1000", () => {
    for (const code of ["KWD", "BHD", "JOD", "OMR", "TND"]) {
      expect(minorUnitExponent(code)).toBe(3);
    }
  });

  it("an unknown code falls through to two decimals rather than throwing", () => {
    expect(minorUnitExponent("ZZZ")).toBe(2);
  });

  it("the lookup is case- and whitespace-insensitive, because providers vary", () => {
    expect(minorUnitExponent("jpy")).toBe(0);
    expect(minorUnitExponent(" kwd ")).toBe(3);
  });
});

describe("minor units become a major-unit decimal string", () => {
  it("a JPY 100,000 capture is ¥100,000, not ¥1,000", () => {
    expect(minorUnitsToDecimalString(100_000, "JPY")).toBe("100000");
  });

  it("a KWD 1.234 capture is KWD 1.234, not KWD 12.34", () => {
    expect(minorUnitsToDecimalString(1234, "KWD")).toBe("1.234");
  });

  it("the two-decimal case is unchanged — this fix must not move INR or USD", () => {
    expect(minorUnitsToDecimalString(99_900, "INR")).toBe("999.00");
    expect(minorUnitsToDecimalString(4999, "USD")).toBe("49.99");
    expect(minorUnitsToDecimalString(49_900, "INR")).toBe("499.00");
  });

  it("amounts smaller than one major unit keep their leading zero", () => {
    expect(minorUnitsToDecimalString(5, "INR")).toBe("0.05");
    expect(minorUnitsToDecimalString(5, "KWD")).toBe("0.005");
    expect(minorUnitsToDecimalString(0, "INR")).toBe("0.00");
    expect(minorUnitsToDecimalString(0, "JPY")).toBe("0");
  });

  it("a large amount survives exactly — no float ever holds the value", () => {
    expect(minorUnitsToDecimalString(123_456_789_012, "INR")).toBe("1234567890.12");
    // 9007199254740991 is Number.MAX_SAFE_INTEGER: the last value a double still holds exactly.
    expect(minorUnitsToDecimalString(9_007_199_254_740_991, "USD")).toBe("90071992547409.91");
  });

  it("a negative amount keeps its sign in the right place", () => {
    expect(minorUnitsToDecimalString(-99_900, "INR")).toBe("-999.00");
    expect(minorUnitsToDecimalString(-5, "JPY")).toBe("-5");
  });

  it("a non-integer is refused rather than rounded — it means the provider sent major units", () => {
    expect(() => minorUnitsToDecimalString(999.5, "INR")).toThrow(/not an integer/);
    expect(() => minorUnitsToDecimalString(Number.NaN, "INR")).toThrow(/not an integer/);
  });
});

describe("the webhook DTO refuses a non-integer minor-unit amount", () => {
  const base = { id: "pay_1", currency: "INR", status: "captured" };

  it("accepts an integer amount", () => {
    expect(paymentWebhookPaymentSchema.safeParse({ ...base, amount: 49_900 }).success).toBe(true);
  });

  it("rejects a fractional amount instead of silently rounding it into an integer column", () => {
    expect(paymentWebhookPaymentSchema.safeParse({ ...base, amount: 499.0001 }).success).toBe(false);
  });

  it("rejects a fractional fee for the same reason", () => {
    expect(paymentWebhookPaymentSchema.safeParse({ ...base, amount: 49_900, fee: 11.8 }).success).toBe(false);
  });
});
