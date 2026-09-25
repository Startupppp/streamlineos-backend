import { KbImportProcessConsumer } from "./kb-import-process.consumer";
import { kbImportJobs, kbPages } from "../../../db/schema";
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

function makeEvent(inputOverride?: Partial<{
  sourceType: string;
  items: Array<{ title: string; contentText?: string; externalId?: string; externalSource?: string }>;
  visibility: string;
  duplicatePolicy: string;
  spaceId?: number;
}>): OutboxEventRow {
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
        items: [{ title: "Doc A", contentText: "body" }],
        visibility: "org",
        duplicatePolicy: "skip",
        ...inputOverride,
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

describe("KbImportProcessConsumer — job gate", () => {
  afterEach(() => jest.resetAllMocks());

  it("skips processing when the job is already completed", async () => {
    const updater = jest.fn();
    const insertMock = jest.fn();

    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ status: "completed" }])),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updater }) }),
      insert: insertMock,
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    expect(updater).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("does not process when job row is not found", async () => {
    const insertMock = jest.fn();
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      insert: insertMock,
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("KbImportProcessConsumer — successful processing", () => {
  afterEach(() => jest.resetAllMocks());

  it("marks job processing then completed and records correct counts", async () => {
    const updateSetWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateSetWhere });
    const updateMock = jest.fn().mockReturnValue({ set: updateSet });

    let updateCallCount = 0;
    updateMock.mockImplementation(() => {
      updateCallCount++;
      return { set: updateSet };
    });

    const pagesReturning = jest
      .fn()
      .mockResolvedValue([{ id: 5, contentRevision: 1, aclRevision: 1 }]);
    const pagesInsertChain = {
      onConflictDoNothing: jest.fn().mockReturnValue({ returning: pagesReturning }),
    };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return makeSelectChain([{ status: "pending" }]);
        }
        return makeSelectChain([]);
      }),
      update: updateMock,
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue(pagesInsertChain) }),
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await consumer.handle(makeEvent());

    const firstSetCall = updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstSetCall?.["status"]).toBe("processing");

    const lastSetCall = updateSet.mock.calls[updateSet.mock.calls.length - 1]?.[0] as Record<string, unknown> | undefined;
    expect(lastSetCall?.["status"]).toBe("completed");
    expect(lastSetCall?.["succeededItems"]).toBe(1);
    expect(lastSetCall?.["failedItems"]).toBe(0);
  });
});

describe("KbImportProcessConsumer — BE-88 failure handling", () => {
  afterEach(() => jest.resetAllMocks());

  it("marks job as failed and rethrows when insert throws", async () => {
    const boom = new Error("db died");
    const updateSetWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateSetWhere });
    const updateMock = jest.fn().mockReturnValue({ set: updateSet });

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([{ status: "pending" }]);
        return makeSelectChain([]);
      }),
      update: updateMock,
      insert: jest.fn().mockImplementation(() => {
        throw boom;
      }),
    } as unknown as Db;

    const consumer = new KbImportProcessConsumer(db, sharedRegistry, sharedAudit);
    await expect(consumer.handle(makeEvent())).rejects.toThrow("db died");

    const lastSetCall = updateSet.mock.calls[updateSet.mock.calls.length - 1]?.[0] as Record<string, unknown> | undefined;
    expect(lastSetCall?.["status"]).toBe("failed");
  });
});

describe("KbImportProcessConsumer — withoutRef TOCTOU invariant", () => {
  afterEach(() => jest.resetAllMocks());

  it("counts a plain-title match as duplicate only when the check runs inside the transaction that is also used for the insert", async () => {
    const insideTxRef = { value: false };

    function makeWhereChain(): { limit: jest.Mock } & PromiseLike<Array<{ title?: string; status?: string }>> {
      const limit = jest.fn().mockResolvedValue([]);
      const thenable: { limit: jest.Mock } & PromiseLike<Array<{ title?: string; status?: string }>> = {
        limit,
        then: <T>(
          onFulfilled: (rows: Array<{ title?: string; status?: string }>) => T,
          onRejected?: (e: unknown) => T,
        ) =>
          Promise.resolve(
            insideTxRef.value ? [{ title: "Existing Doc" }] : [{ status: "pending" }],
          ).then(onFulfilled, onRejected),
      };
      return thenable;
    }

    const updateSetWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateSetWhere });

    const pagesInsert = {
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    };

    let selectCallCount = 0;
    const db: Partial<Db> & { select: jest.Mock; update: jest.Mock; insert: jest.Mock } = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() => makeWhereChain()),
          }),
        };
      }),
      update: jest.fn().mockReturnValue({ set: updateSet }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue(pagesInsert) }),
    };

    const { runInNewTenantTransaction } = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ) as { runInNewTenantTransaction: jest.Mock };

    runInNewTenantTransaction.mockImplementation(
      async (dbArg: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
        insideTxRef.value = true;
        try {
          return await fn(dbArg);
        } finally {
          insideTxRef.value = false;
        }
      },
    );

    const consumer = new KbImportProcessConsumer(db as unknown as Db, sharedRegistry, sharedAudit);

    const event: OutboxEventRow = {
      eventId: "evt-2",
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
          items: [{ title: "Existing Doc", contentText: "body" }],
          visibility: "org",
          duplicatePolicy: "skip",
        },
      },
    } as unknown as OutboxEventRow;

    await consumer.handle(event);

    const lastSetCall = updateSet.mock.calls[updateSet.mock.calls.length - 1]?.[0] as Record<string, unknown> | undefined;
    expect(lastSetCall?.["duplicateItems"]).toBe(1);
    expect(lastSetCall?.["succeededItems"]).toBe(0);
  });
});
