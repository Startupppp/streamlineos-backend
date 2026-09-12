import { updateBillingProfileSchema } from "./dto/billing.schemas";

describe("isTaxExempt authority contract — customer update path", () => {
  it("accepts a profile update that omits isTaxExempt entirely", () => {
    const result = updateBillingProfileSchema.safeParse({
      billingName: "Acme Corp",
      country: "IN",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a customer request body that includes isTaxExempt=true (strict schema)", () => {
    const result = updateBillingProfileSchema.safeParse({
      billingName: "Acme Corp",
      isTaxExempt: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mentionsField = result.error.issues.some(
        (i) => i.message.toLowerCase().includes("isTaxExempt".toLowerCase()),
      );
      expect(mentionsField).toBe(true);
    }
  });

  it("rejects a customer request body that includes isTaxExempt=false (strict schema)", () => {
    const result = updateBillingProfileSchema.safeParse({
      isTaxExempt: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a request that sends isTaxExempt alongside other valid fields", () => {
    const result = updateBillingProfileSchema.safeParse({
      billingName: "Acme",
      billingEmail: "billing@acme.com",
      country: "IN",
      isTaxExempt: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts every other billing profile field without isTaxExempt", () => {
    const result = updateBillingProfileSchema.safeParse({
      gstin: "22AAAAA0000A1Z5",
      pan: "ABCDE1234F",
      billingName: "Acme Corp",
      billingEmail: "billing@acme.com",
      addressLine1: "123 Main St",
      addressLine2: "Suite 4",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      country: "IN",
    });
    expect(result.success).toBe(true);
  });
});

describe("isTaxExempt authority contract — invoice pricing does not read the field", () => {
  it("priceDocument signature accepts only taxRateBps per line, not isTaxExempt", async () => {
    const { priceDocument } = await import("./invoice-pricing");
    const doc = priceDocument(
      [
        {
          lineType: "SUBSCRIPTION",
          description: "Pro plan",
          quantity: 1,
          unitAmountMinor: 10000,
          taxRateBps: 1800,
        },
      ],
      "HALF_UP",
      "EXCLUSIVE",
    );
    expect(doc.taxAmountMinor).toBe(1800);
    expect(doc.totalMinor).toBe(11800);
  });

  it("a line with taxRateBps=0 produces zero tax regardless of any external state", () => {
    const { priceDocument } = require("./invoice-pricing") as typeof import("./invoice-pricing");
    const doc = priceDocument(
      [
        {
          lineType: "SUBSCRIPTION",
          description: "Pro plan",
          quantity: 1,
          unitAmountMinor: 10000,
          taxRateBps: 0,
        },
      ],
      "HALF_UP",
      "EXCLUSIVE",
    );
    expect(doc.taxAmountMinor).toBe(0);
    expect(doc.totalMinor).toBe(10000);
  });
});
