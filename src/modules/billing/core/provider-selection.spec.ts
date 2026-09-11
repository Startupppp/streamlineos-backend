import { selectProvider } from "./provider-selection";

const BOTH = { razorpay: true, stripe: true };

describe("selectProvider", () => {
  it("charges rupees through Razorpay, which settles them domestically", () => {
    expect(selectProvider("INR", BOTH)).toEqual({
      ok: true,
      provider: "razorpay",
      isPreferred: true,
    });
  });

  it.each(["EUR", "USD", "GBP"])("charges %s through Stripe", (currency) => {
    expect(selectProvider(currency, BOTH)).toMatchObject({
      provider: "stripe",
      isPreferred: true,
    });
  });

  /**
   * Currency, not country.
   *
   * A British company with an Indian subsidiary billed in INR is charged where
   * INR settles. Asking which country they are in gets that wrong, and the
   * charge row records the currency -- so this rule is checkable afterwards and
   * a country rule would not be.
   */
  it("routes on the currency alone, whatever else is known about the customer", () => {
    expect(selectProvider("inr", BOTH)).toMatchObject({ provider: "razorpay" });
    expect(selectProvider(" INR ", BOTH)).toMatchObject({ provider: "razorpay" });
  });

  it("falls back rather than refusing a sale it could take", () => {
    expect(selectProvider("EUR", { razorpay: true, stripe: false })).toEqual({
      ok: true,
      provider: "razorpay",
      isPreferred: false,
    });
  });

  /**
   * The half that matters more than the fallback itself.
   *
   * Charging a euro customer through the wrong provider *silently* is how the
   * currency problem happened the first time. The caller has to be able to tell.
   */
  it("says when it fell back, so nobody is charged through a surprise", () => {
    const selection = selectProvider("EUR", { razorpay: true, stripe: false });

    expect(selection).toMatchObject({ isPreferred: false });
  });

  it("refuses when nothing is configured, rather than picking one anyway", () => {
    const selection = selectProvider("EUR", { razorpay: false, stripe: false });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toContain("EUR");
  });

  it("refuses an empty currency instead of defaulting to rupees", () => {
    // A default here is the currency bug with a longer fuse: a caller that
    // forgets charges INR to somebody who was quoted dollars.
    expect(selectProvider("", BOTH).ok).toBe(false);
    expect(selectProvider("   ", BOTH).ok).toBe(false);
  });
});
