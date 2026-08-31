import { resolveProviderEventId, validateNormalizedPaymentWebhook } from "./payment-webhook-receiver.service";

describe("provider-neutral webhook ingress contract", () => {
  it("rejects a malformed payment entity before it can be recorded as processed", () => {
    const result = validateNormalizedPaymentWebhook({
      eventType: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", amount: "not-a-number" } } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts non-payment events without requiring payment fields", () => {
    const result = validateNormalizedPaymentWebhook({ eventType: "refund.created", payload: {} });
    expect(result.success).toBe(true);
  });

  it("rejects an event-id header that disagrees with the signed provider envelope", () => {
    expect(resolveProviderEventId("header-id", { providerEventId: "body-id" }, "{}")).toEqual({ ok: false });
  });

  it("uses a stable body digest when neither event-id source is present", () => {
    const first = resolveProviderEventId(undefined, {}, "same-body");
    const second = resolveProviderEventId(undefined, {}, "same-body");
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });
});
