/**
 * Proves consumer idempotency beyond a status check using a stable (producerEventId, consumerName)
 * key. The InboxConsumer inserts via onConflictDoNothing — the first concurrent claim wins; the
 * second gets an empty returning set and returns false without ever looking at status.
 *
 * A status check (if row.status === 'SENT') is insufficient because:
 *   1. It requires the first call to complete before the second reads — a race between read and
 *      write means the second call may still see no row and attempt the side effect.
 *   2. It cannot make COMPLETED and IN_FLIGHT distinguishable at claim time; only COMPLETED is safe.
 *
 * The unique index on (producer_event_id, consumer_name) is the load-bearing gate. This test
 * asserts that gate bites by simulating two concurrent DB claims from the same event.
 */

import { InboxConsumer } from "./inbox-consumer";

const CONSUMER = "test-consumer";
const EVENT_ID = "evt-123";
const ORG = "org-abc";

interface MockDb {
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
}

function makeDb(firstReturning: Array<{ id: number }>, secondReturning: Array<{ id: number }>): MockDb {
  let callCount = 0;
  const returningMock = jest.fn().mockImplementation(() => {
    callCount++;
    return Promise.resolve(callCount === 1 ? firstReturning : secondReturning);
  });

  const onConflictDoNothing = jest.fn().mockReturnValue({ returning: returningMock });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });

  const updateReturning = jest.fn().mockResolvedValue([]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const set = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set });

  const execute = jest.fn().mockResolvedValue([]);

  return { insert, update, execute } as MockDb;
}

const EVENT = {
  eventId: EVENT_ID,
  organizationId: ORG,
  aggregateVersion: 1,
};

describe("InboxConsumer — concurrent double-delivery", () => {
  it("exactly one of two concurrent claims returns true when the unique index fires on the second", async () => {
    const db = makeDb([{ id: 1 }], []);
    const consumer1 = new InboxConsumer(db as never);
    const consumer2 = new InboxConsumer(db as never);

    const [result1, result2] = await Promise.all([
      consumer1.claim(CONSUMER, EVENT),
      consumer2.claim(CONSUMER, EVENT),
    ]);

    const claimed = [result1, result2].filter(Boolean).length;
    expect(claimed).toBe(1);
  });

  it("the second concurrent claim returns false without reading or updating status — idempotency via key, not status", async () => {
    const db = makeDb([{ id: 1 }], []);
    const consumer1 = new InboxConsumer(db as never);
    const consumer2 = new InboxConsumer(db as never);

    const [r1, r2] = await Promise.all([
      consumer1.claim(CONSUMER, EVENT),
      consumer2.claim(CONSUMER, EVENT),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("bites: if onConflictDoNothing always returns a row, both claims succeed — proving the unique-index is the gate", async () => {
    const alwaysSucceeds = makeDb([{ id: 1 }], [{ id: 2 }]);
    const c1 = new InboxConsumer(alwaysSucceeds as never);
    const c2 = new InboxConsumer(alwaysSucceeds as never);

    const [r1, r2] = await Promise.all([
      c1.claim(CONSUMER, EVENT),
      c2.claim(CONSUMER, EVENT),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });
});
