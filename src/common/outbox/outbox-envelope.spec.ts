import {
  buildOutboxEvent,
  nextRetryDelayMs,
  nextRetryDelayWithJitterMs,
  shouldDeadLetter,
  shouldSuppressForLifecycle,
  OUTBOX_MAX_RETRIES,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
} from "./outbox-envelope";
import type { OutboxEventInput } from "./outbox-event-schema";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const OCCURRED = new Date("2026-07-26T12:00:00.000Z");

function makeInput(overrides: Partial<OutboxEventInput> = {}): OutboxEventInput {
  return {
    eventId: VALID_UUID,
    organizationId: "org-1",
    aggregateType: "organization",
    aggregateId: "org-1",
    aggregateVersion: 1,
    eventType: "organization.created",
    payload: { name: "Acme" },
    occurredAt: OCCURRED,
    ...overrides,
  };
}

describe("buildOutboxEvent", () => {
  it("builds a PENDING event with lifecycle ACTIVE and zero retries", () => {
    const event = buildOutboxEvent(makeInput());
    expect(event.deliveryState).toBe("PENDING");
    expect(event.lifecycleState).toBe("ACTIVE");
    expect(event.retryCount).toBe(0);
    expect(event.eventId).toBe(VALID_UUID);
    expect(event.eventType).toBe("organization.created");
    expect(event.payload).toEqual({ name: "Acme" });
    expect(event.occurredAt).toBe(OCCURRED);
  });

  it("applies defaults for optional fields", () => {
    const event = buildOutboxEvent(makeInput());
    expect(event.schemaVersion).toBe(1);
    expect(event.audience).toBe("INTERNAL");
    expect(event.causationId).toBeNull();
    expect(event.correlationId).toBeNull();
    expect(event.actorMembershipId).toBeNull();
  });

  it("preserves provided causation/correlation/audience/actor", () => {
    const event = buildOutboxEvent(
      makeInput({
        audience: "PORTAL",
        actorMembershipId: "mem-9",
        causationId: "22222222-2222-4222-8222-222222222222",
        correlationId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(event.audience).toBe("PORTAL");
    expect(event.actorMembershipId).toBe("mem-9");
    expect(event.causationId).toBe("22222222-2222-4222-8222-222222222222");
    expect(event.correlationId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("rejects a non-uuid eventId", () => {
    expect(() => buildOutboxEvent(makeInput({ eventId: "not-a-uuid" }))).toThrow();
  });

  it("rejects a non-positive aggregateVersion (monotonic must start at 1)", () => {
    expect(() => buildOutboxEvent(makeInput({ aggregateVersion: 0 }))).toThrow();
    expect(() => buildOutboxEvent(makeInput({ aggregateVersion: -1 }))).toThrow();
  });

  it("rejects an empty aggregateType", () => {
    expect(() => buildOutboxEvent(makeInput({ aggregateType: "" }))).toThrow();
  });
});

describe("nextRetryDelayMs", () => {
  it("returns the base delay for the first retry", () => {
    expect(nextRetryDelayMs(0)).toBe(OUTBOX_RETRY_BASE_MS);
  });

  it("grows exponentially with retry count", () => {
    expect(nextRetryDelayMs(1)).toBe(OUTBOX_RETRY_BASE_MS * 2);
    expect(nextRetryDelayMs(2)).toBe(OUTBOX_RETRY_BASE_MS * 4);
    expect(nextRetryDelayMs(3)).toBe(OUTBOX_RETRY_BASE_MS * 8);
  });

  it("caps at the maximum delay", () => {
    expect(nextRetryDelayMs(100)).toBe(OUTBOX_RETRY_MAX_MS);
  });

  it("treats a negative retry count as the base delay", () => {
    expect(nextRetryDelayMs(-5)).toBe(OUTBOX_RETRY_BASE_MS);
  });
});

describe("nextRetryDelayWithJitterMs", () => {
  it("never returns the same delay twice for a whole claim batch", () => {
    const batch = Array.from({ length: 50 }, () => nextRetryDelayWithJitterMs(5));
    expect(new Set(batch).size).toBeGreaterThan(1);
  });

  it("stays within [base, deterministic ceiling] for every retry count", () => {
    for (let retryCount = 0; retryCount <= 12; retryCount++) {
      const ceiling = nextRetryDelayMs(retryCount);
      for (const random of [() => 0, () => 0.5, () => 0.999999]) {
        const delay = nextRetryDelayWithJitterMs(retryCount, random);
        expect(delay).toBeGreaterThanOrEqual(OUTBOX_RETRY_BASE_MS);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("collapses to the base delay when there is no span to jitter over", () => {
    expect(nextRetryDelayWithJitterMs(0, () => 0.9)).toBe(OUTBOX_RETRY_BASE_MS);
    expect(nextRetryDelayWithJitterMs(-5, () => 0.9)).toBe(OUTBOX_RETRY_BASE_MS);
  });

  it("never exceeds the maximum delay once the ceiling is capped", () => {
    expect(nextRetryDelayWithJitterMs(100, () => 0.999999)).toBeLessThanOrEqual(OUTBOX_RETRY_MAX_MS);
  });
});

describe("shouldDeadLetter", () => {
  it("does not dead-letter before the retry ceiling", () => {
    expect(shouldDeadLetter(0)).toBe(false);
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES - 1)).toBe(false);
  });

  it("dead-letters at and beyond the retry ceiling", () => {
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES)).toBe(true);
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES + 50)).toBe(true);
  });
});

describe("shouldSuppressForLifecycle", () => {
  it("does not suppress an ACTIVE organization", () => {
    expect(shouldSuppressForLifecycle("ACTIVE")).toBe(false);
  });

  it("suppresses archived, purge-scheduled, and purged organizations", () => {
    expect(shouldSuppressForLifecycle("ARCHIVED")).toBe(true);
    expect(shouldSuppressForLifecycle("PURGE_SCHEDULED")).toBe(true);
    expect(shouldSuppressForLifecycle("PURGED")).toBe(true);
  });
});
