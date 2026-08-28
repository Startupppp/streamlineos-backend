import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  nextRetryDelayMs,
  shouldDeadLetter,
  OUTBOX_MAX_RETRIES,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
} from "../common/outbox/outbox-envelope";
import { OutboxWriter } from "../common/outbox/outbox-writer";
import { outboxEvents } from "../db/schema/common/outbox";
import type { OutboxEventInput } from "../common/outbox/outbox-event-schema";
import type { DbOrTx } from "../common/rbac/access-invalidate";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;

function makeValidEvent(): OutboxEventInput {
  return {
    eventId: randomUUID(),
    organizationId: "org-email-test",
    aggregateType: "invitation",
    aggregateId: "inv-1",
    aggregateVersion: 1,
    eventType: "invitation.created",
    payload: { email: "new@example.com" },
    occurredAt: new Date(),
  };
}

describe("Email provider degraded — request transaction stays committed", () => {
  it("OutboxWriter.emit inserts the event into the caller's existing transaction", async () => {
    const values = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values });

    const tx = { insert } as unknown as DbOrTx;

    await OutboxWriter.emit(tx, makeValidEvent());

    expect(insert).toHaveBeenCalledWith(outboxEvents);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("the insert is called with deliveryState PENDING — the event survives a delivery failure", async () => {
    let inserted: Record<string, unknown> | undefined;
    const values = jest.fn().mockImplementation((row: Record<string, unknown>) => {
      inserted = row;
      return Promise.resolve(undefined);
    });
    const insert = jest.fn().mockReturnValue({ values });

    const tx = { insert } as unknown as DbOrTx;

    await OutboxWriter.emit(tx, makeValidEvent());

    expect(inserted?.["deliveryState"]).toBe("PENDING");
  });

  it("OutboxWriter.emit resolves even if called multiple times — each emit is its own row", async () => {
    const calls: unknown[] = [];
    const values = jest.fn().mockImplementation((row: unknown) => {
      calls.push(row);
      return Promise.resolve(undefined);
    });
    const insert = jest.fn().mockReturnValue({ values });
    const tx = { insert } as unknown as DbOrTx;

    const event = makeValidEvent();
    await OutboxWriter.emit(tx, event);
    await OutboxWriter.emit(tx, { ...event, eventId: randomUUID() });

    expect(calls).toHaveLength(2);
  });
});

describe("Retry state machine — outbox retries and dead-letters on provider failure", () => {
  it("nextRetryDelayMs grows exponentially from OUTBOX_RETRY_BASE_MS", () => {
    const delays = [1, 2, 3, 4, 5].map(nextRetryDelayMs);
    for (let i = 1; i < delays.length; i++) {
      const prev = delays[i - 1];
      const curr = delays[i];
      if (prev !== undefined && curr !== undefined && prev < OUTBOX_RETRY_MAX_MS)
        expect(curr).toBeGreaterThan(prev);
    }
  });

  it("first retry delay starts at OUTBOX_RETRY_BASE_MS", () => {
    expect(nextRetryDelayMs(0)).toBe(OUTBOX_RETRY_BASE_MS);
  });

  it("retry delay is bounded at OUTBOX_RETRY_MAX_MS regardless of retry count", () => {
    expect(nextRetryDelayMs(100)).toBe(OUTBOX_RETRY_MAX_MS);
    expect(nextRetryDelayMs(50)).toBe(OUTBOX_RETRY_MAX_MS);
  });

  it("shouldDeadLetter returns false before the max retry count", () => {
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++)
      expect(shouldDeadLetter(i)).toBe(false);
  });

  it("shouldDeadLetter returns true at exactly OUTBOX_MAX_RETRIES — event is dead-lettered, not discarded", () => {
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES)).toBe(true);
  });

  it("shouldDeadLetter returns true beyond OUTBOX_MAX_RETRIES — no infinite retry loop", () => {
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES + 5)).toBe(true);
  });
});

describe("Email provider degraded — outbox retry state machine", () => {
  it.skip(
    "integration: a 503 from the provider increments retryCount and returns the event to PENDING — needs OutboxPublisherService / AiCreditsReservationService driven end to end; those services open their own transactions via runInNewTenantTransaction, so their writes cannot be rolled back on a database shared with concurrent sessions — asserting hand-written SQL state instead proves only that Postgres stores what was written",
    () => {},
  );

  it.skip(
    "integration: reaching OUTBOX_MAX_RETRIES dead-letters the event while the request row stays committed — same blocker as above",
    () => {},
  );

  it.skip(
    "integration: the request transaction commits before any delivery attempt — same blocker as above",
    () => {},
  );
});
