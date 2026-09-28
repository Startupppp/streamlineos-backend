import { KbImportProcessConsumer } from "./kb-import-process.consumer";
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

function rint(): jest.Mock {
  const { runInNewTenantTransaction } = jest.requireMock(
    "../../../common/tenant/run-in-tenant-transaction",
  ) as { runInNewTenantTransaction: jest.Mock };
  return runInNewTenantTransaction;
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

function makeEvent(
  items: Array<{ title: string; contentText?: string }>,
  duplicatePolicy: "skip" | "update",
): OutboxEventRow {
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
        items,
        visibility: "org",
        duplicatePolicy,
      },
    },
  } as unknown as OutboxEventRow;
}

afterEach(() => jest.clearAllMocks());

describe("KbImportProcessConsumer — plain item deduplication by title", () => {
  it("counts a plain item as duplicate and skips insert when matching title exists in same org", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return makeSelectChain([{ status: "pending" }]);
        if (selectCount === 2) return makeSelectChain([]);
        return makeSelectChain([{ title: "My Doc" }]);
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
          updateCalls.push(vals);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
      insert: jest.fn(),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(makeEvent([{ title: "My Doc", contentText: "body" }], "skip"));

    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["duplicateItems"]).toBe(1);
    expect(last?.["succeededItems"]).toBe(0);
  });

  it("inserts a plain item and does not count it as duplicate when title is absent from org", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return makeSelectChain(selectCount === 1 ? [{ status: "pending" }] : []);
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
            returning: jest.fn().mockResolvedValue([{ id: 7, contentRevision: 1, aclRevision: 1 }]),
          }),
        }),
      }),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(makeEvent([{ title: "Brand New Page", contentText: "body" }], "skip"));

    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["succeededItems"]).toBe(1);
    expect(last?.["duplicateItems"]).toBe(0);
  });

  it("does not skip a plain item when duplicatePolicy is update even if the title exists", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return makeSelectChain(selectCount === 1 ? [{ status: "pending" }] : []);
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
            returning: jest.fn().mockResolvedValue([{ id: 9, contentRevision: 1, aclRevision: 1 }]),
          }),
        }),
      }),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(makeEvent([{ title: "Existing", contentText: "updated body" }], "update"));

    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["duplicateItems"]).toBe(0);
    expect(last?.["succeededItems"]).toBe(1);
  });
});

describe("KbImportProcessConsumer — resuming an interrupted run", () => {
  it("re-runs a job whose row was left in processing, because a run that died mid-batch is only resumable if the status gate lets the redelivered event back in", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const insertedValues: unknown[][] = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return makeSelectChain(selectCount === 1 ? [{ status: "processing" }] : []);
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
          updateCalls.push(vals);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((rows: unknown[]) => {
          insertedValues.push(rows);
          return {
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest
                .fn()
                .mockResolvedValue([{ id: 21, contentRevision: 1, aclRevision: 1 }]),
            }),
          };
        }),
      }),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(makeEvent([{ title: "Resumed Doc", contentText: "body" }], "skip"));

    expect(insertedValues).toHaveLength(1);
    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["succeededItems"]).toBe(1);
  });

  it("re-runs the second pass without re-creating the pages the first pass already committed, because the title probe reads committed rows rather than in-run state", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return makeSelectChain([{ status: "processing" }]);
        if (selectCount === 2) return makeSelectChain([]);
        return makeSelectChain([{ title: "Already Committed" }]);
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
          updateCalls.push(vals);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
      insert: jest.fn(),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(makeEvent([{ title: "Already Committed", contentText: "body" }], "skip"));

    expect(tx.insert).not.toHaveBeenCalled();
    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["duplicateItems"]).toBe(1);
    expect(last?.["succeededItems"]).toBe(0);
  });
});

describe("KbImportProcessConsumer — every processed item lands in exactly one report bucket", () => {
  it("counts a row that onConflictDoNothing dropped as a duplicate rather than losing it, because succeeded plus failed plus duplicate is the only arithmetic that lets a caller tell a partial import from a whole one", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return makeSelectChain(selectCount === 1 ? [{ status: "pending" }] : []);
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
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 31, contentRevision: 1, aclRevision: 1 }]),
          }),
        }),
      }),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(
      makeEvent(
        [
          { title: "Kept", contentText: "body" },
          { title: "Silently Dropped", contentText: "body" },
        ],
        "skip",
      ),
    );

    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["succeededItems"]).toBe(1);
    expect(last?.["duplicateItems"]).toBe(1);
    expect(last?.["failedItems"]).toBe(0);
    expect(
      Number(last?.["succeededItems"]) +
        Number(last?.["duplicateItems"]) +
        Number(last?.["failedItems"]),
    ).toBe(Number(last?.["processedItems"]));
  });

  it("does not inflate the duplicate count when the insert returns every row it was given, so the accounting above is the conflict and not a constant", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return makeSelectChain(selectCount === 1 ? [{ status: "pending" }] : []);
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
            returning: jest.fn().mockResolvedValue([
              { id: 41, contentRevision: 1, aclRevision: 1 },
              { id: 42, contentRevision: 1, aclRevision: 1 },
            ]),
          }),
        }),
      }),
    };
    rint().mockImplementation((_: unknown, __: string, fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const consumer = new KbImportProcessConsumer({} as Db, sharedRegistry, sharedAudit, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await consumer.handle(
      makeEvent(
        [
          { title: "One", contentText: "body" },
          { title: "Two", contentText: "body" },
        ],
        "skip",
      ),
    );

    const last = updateCalls[updateCalls.length - 1];
    expect(last?.["succeededItems"]).toBe(2);
    expect(last?.["duplicateItems"]).toBe(0);
  });
});
