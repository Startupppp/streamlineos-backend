import { OutboxWriter } from "./outbox-writer";
import { type OutboxEventInput } from "./outbox-event-schema";
import { type DbOrTx } from "../rbac/access-invalidate";
import { withDelegatingTransaction } from "../../test/delegating-transaction";

/**
 * The outbox row and the domain write must share one fate.
 *
 * `OutboxWriter.emit` takes the caller's `tx`, which is the whole point of a
 * transactional outbox: if it ever wrote through a handle of its own — a module
 * db, a fresh connection, a `db.transaction()` it opened itself — the event
 * would survive a rolled-back domain write and a consumer would act on
 * something that never happened. Nothing asserted that, so the guarantee rested
 * on every future producer reading the doc comment.
 *
 * The double below commits only what the transaction callback returns
 * normally; a throw discards the buffer the way Postgres discards a rolled-back
 * transaction. A writer that bypassed the handed `tx` would land its row
 * outside that buffer and the rollback case would fail.
 */
function transactionalDbDouble(): {
  db: { transaction: <T>(run: (tx: DbOrTx) => Promise<T>) => Promise<T> };
  committed: Record<string, unknown>[];
  uncommitted: Record<string, unknown>[];
} {
  const committed: Record<string, unknown>[] = [];
  let pending: Record<string, unknown>[] = [];

  const tx = withDelegatingTransaction({
    insert: () => ({
      values: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        pending.push(...(Array.isArray(rows) ? rows : [rows]));
        return Promise.resolve();
      },
    }),
  });

  return {
    committed,
    get uncommitted(): Record<string, unknown>[] {
      return pending;
    },
    db: {
      async transaction<T>(run: (handle: DbOrTx) => Promise<T>): Promise<T> {
        pending = [];
        try {
          const result = await (tx as unknown as {
            transaction: (r: (h: DbOrTx) => Promise<T>) => Promise<T>;
          }).transaction(run);
          committed.push(...pending);
          return result;
        } catch (error) {
          pending = [];
          throw error;
        }
      },
    },
  };
}

function eventInput(overrides: Partial<OutboxEventInput> = {}): OutboxEventInput {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    aggregateType: "hr_employee",
    aggregateId: "emp-1",
    aggregateVersion: 1,
    eventType: "hr.employee.created",
    payload: { employeeId: "emp-1" },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("OutboxWriter transactionality", () => {
  it("leaves no outbox row when the domain transaction rolls back", async () => {
    const { db, committed, uncommitted } = transactionalDbDouble();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert({} as never).values({ kind: "domain-row" } as never);
        await OutboxWriter.emit(tx, eventInput());
        throw new Error("the domain write failed after the event was emitted");
      }),
    ).rejects.toThrow("the domain write failed");

    expect(committed).toEqual([]);
    expect(uncommitted).toEqual([]);
  });

  it("leaves no outbox row when a batch emit is followed by a rollback", async () => {
    const { db, committed } = transactionalDbDouble();

    await expect(
      db.transaction(async (tx) => {
        await OutboxWriter.emitMany(tx, [
          eventInput(),
          eventInput({ eventId: "22222222-2222-4222-8222-222222222222" }),
        ]);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(committed).toEqual([]);
  });

  it("commits the event with the domain row when the transaction succeeds", async () => {
    const { db, committed } = transactionalDbDouble();

    await db.transaction(async (tx) => {
      await tx.insert({} as never).values({ kind: "domain-row" } as never);
      await OutboxWriter.emit(tx, eventInput());
    });

    // The positive control: without it a writer that silently dropped every
    // event would pass the rollback cases above.
    expect(committed).toHaveLength(2);
    expect(committed[1]).toMatchObject({
      eventType: "hr.employee.created",
      organizationId: "org-1",
      deliveryState: "PENDING",
    });
  });
});
