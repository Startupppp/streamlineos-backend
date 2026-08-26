import { outboxEffectIdempotencyKey } from "./outbox-consumer.registry";

describe("outboxEffectIdempotencyKey", () => {
  it("is stable across retries and isolates organizations and consumers", () => {
    const event = { organizationId: "org-1", eventId: "evt-7" };

    expect(outboxEffectIdempotencyKey(event, "notifications:bill-approved"))
      .toBe("outbox:org-1:notifications:bill-approved:evt-7");
    expect(outboxEffectIdempotencyKey(event, "notifications:bill-approved"))
      .toBe(outboxEffectIdempotencyKey(event, "notifications:bill-approved"));
    expect(outboxEffectIdempotencyKey(event, "other-consumer"))
      .not.toBe(outboxEffectIdempotencyKey(event, "notifications:bill-approved"));
  });
});
