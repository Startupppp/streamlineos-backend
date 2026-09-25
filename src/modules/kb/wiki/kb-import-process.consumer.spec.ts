import { KbImportProcessConsumer } from "./kb-import-process.consumer";
import { kbImportJobs } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { OutboxConsumerRegistry, OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  ),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

const sharedAudit = { log: jest.fn() } as unknown as AuditService;
const sharedRegistry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;

function makeEvent(itemsOverride?: Array<{ title: string; contentText?: string }>, duplicatePolicy = "skip"): OutboxEventRow {
  return {
    eventId: "evt-1",
    organizationId: "org-A",
    aggregateType: "kb_import_job",
    aggregateId: "1",
    aggregateVersion: 1,
    eventType: "kb.import.process",
    payload: {
      jobId: 1,
      userId: "user-1",
      orgId: "org-A",
      input: {
        sourceType: "markdown",
        items: itemsOverride ?? [{ title: "Doc A", contentText: "body" }],
        visibility: "org",
        duplicatePolicy,
      },
    },
  } as unknown as OutboxEventRow;
}

function makeSelectChain(rows: unknown[] = []) {
  const chain = Object.assign(Promise.resolve(rows), {
    from: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    limit: jest.fn(),
  });
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function rint(): jest.Mock {
  const { runInNewTenantTransaction } = jest.requireMock(
    "../../../common/tenant/run-in-tenant-transaction",
  ) as { runInNewTenantTransaction: jest.Mock };
  return runInNewTenantTransaction;
}

afterEach(() => jest.clearAllMocks());

describe("KbImportProcessConsumer — job gate", () => {
  it("skips processing when the job is already completed", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ status: "completed" }])),
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });

  it("does not process when job row is not found", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe("KbImportProcessConsumer — successful processing", () => {
  it("marks job processing then completed and records correct counts", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];

    function makeTxFor(statusRows: unknown[], titleRows: unknown[] = [], insertedRows: unknown[] = []) {
      let selectCount = 0;
      return {
        select: jest.fn().mockImplementation(() => {
          selectCount++;
          if (selectCount === 1) return makeSelectChain(statusRows);
          if (selectCount === 2) return makeSelectChain([]);
          return makeSelectChain(titleRows);
        }),
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateCalls.push(vals);
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        })),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue(insertedRows),
            }),
          }),
        }),
      };
    }

    const tx = makeTxFor([{ status: "pending" }], [], [{ id: 5, contentRevision: 1, aclRevision: 1 }]);

    rint().mockImplementation((_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    expect(updateCalls[0]?.["status"]).toBe("processing");
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.["status"]).toBe("completed");
    expect(lastCall?.["succeededItems"]).toBe(1);
    expect(lastCall?.["failedItems"]).toBe(0);
  });
});

describe("KbImportProcessConsumer — BE-88 failure handling", () => {
  it("marks job as failed and rethrows when processing throws outside the per-batch catch", async () => {
    const boom = new Error("infra failure");
    const updateCalls: Array<Record<string, unknown>> = [];
    let callCount = 0;

    rint().mockImplementation(async (_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1) {
        const tx = {
          select: jest.fn().mockReturnValue(makeSelectChain([{ status: "pending" }])),
          update: jest.fn().mockImplementation(() => ({
            set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              updateCalls.push(vals);
              return { where: jest.fn().mockResolvedValue(undefined) };
            }),
          })),
        };
        return fn(tx);
      }
      if (callCount === 2) {
        throw boom;
      }
      const updateTx = {
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateCalls.push(vals);
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        })),
      };
      return fn(updateTx);
    });

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit);
    await expect(consumer.handle(makeEvent())).rejects.toThrow("infra failure");

    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.["status"]).toBe("failed");
  });
});

describe("KbImportProcessConsumer — withoutRef TOCTOU invariant", () => {
  it("title check and insert for withoutRef run in the same runInNewTenantTransaction call", async () => {
    const selectsOnSharedTx: string[] = [];
    const insertsOnSharedTx: string[] = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    let callCount = 0;

    rint().mockImplementation(async (_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => {
      callCount++;

      if (callCount === 1) {
        const tx = {
          select: jest.fn().mockReturnValue(makeSelectChain([{ status: "pending" }])),
          update: jest.fn().mockImplementation(() => ({
            set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              updateCalls.push(vals);
              return { where: jest.fn().mockResolvedValue(undefined) };
            }),
          })),
        };
        return fn(tx);
      }

      if (callCount === 2) {
        return fn({ select: jest.fn().mockReturnValue(makeSelectChain([])) });
      }

      if (callCount === 3) {
        const sharedTx = {
          select: jest.fn().mockImplementation(() => {
            selectsOnSharedTx.push("select");
            return makeSelectChain([{ title: "Existing Doc" }]);
          }),
          insert: jest.fn().mockImplementation(() => {
            insertsOnSharedTx.push("insert");
            return {
              values: jest.fn().mockReturnValue({
                onConflictDoNothing: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([{ id: 9, contentRevision: 1, aclRevision: 1 }]),
                }),
              }),
            };
          }),
        };
        return fn(sharedTx);
      }

      const updateTx = {
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateCalls.push(vals);
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        })),
      };
      return fn(updateTx);
    });

    const event = makeEvent(
      [
        { title: "Existing Doc", contentText: "body" },
        { title: "New Doc", contentText: "body" },
      ],
      "skip",
    );

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit);
    await consumer.handle(event);

    expect(selectsOnSharedTx.length).toBeGreaterThan(0);
    expect(insertsOnSharedTx.length).toBeGreaterThan(0);

    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.["duplicateItems"]).toBe(1);
    expect(lastCall?.["succeededItems"]).toBe(1);
  });

  it("counts a plain-title item as duplicate only when found inside the tenant transaction", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let callCount = 0;

    rint().mockImplementation(async (_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => {
      callCount++;

      if (callCount === 1) {
        const tx = {
          select: jest.fn().mockReturnValue(makeSelectChain([{ status: "pending" }])),
          update: jest.fn().mockImplementation(() => ({
            set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              updateCalls.push(vals);
              return { where: jest.fn().mockResolvedValue(undefined) };
            }),
          })),
        };
        return fn(tx);
      }

      if (callCount === 2) {
        return fn({ select: jest.fn().mockReturnValue(makeSelectChain([])) });
      }

      if (callCount === 3) {
        const withoutRefTx = {
          select: jest.fn().mockReturnValue(makeSelectChain([{ title: "Only Doc" }])),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return fn(withoutRefTx);
      }

      const updateTx = {
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateCalls.push(vals);
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        })),
      };
      return fn(updateTx);
    });

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent([{ title: "Only Doc", contentText: "body" }], "skip"));

    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.["duplicateItems"]).toBe(1);
    expect(lastCall?.["succeededItems"]).toBe(0);
  });
});
