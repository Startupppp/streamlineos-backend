/**
 * Journal outbox semantics (FR-ACC-001).
 *
 * The db is a scripted double: it returns queued results in call order and
 * records every insert/update payload. That is enough to assert the parts that
 * carry accounting risk — a posted batch is never mutated, a reversal swaps
 * debits and credits, and lifecycle guards reject invalid transitions.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { JournalOutboxService } from "../journal-outbox.service";

interface Recorded {
  inserts: { values: unknown }[];
  updates: { set: Record<string, unknown> }[];
}

function makeDb(queue: unknown[][], rec: Recorded) {
  const next = (): unknown[] => queue.shift() ?? [];

  const selectChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.orderBy = step;
    chain.offset = step;
    chain.limit = step;
    // Awaiting any point in the chain resolves the next queued result.
    chain.then = (resolve: (v: unknown[]) => unknown) => resolve(next());
    return chain;
  };

  const db: Record<string, unknown> = {
    select: () => selectChain(),
    insert: () => ({
      values: (values: unknown) => {
        rec.inserts.push({ values });
        return {
          returning: () => Promise.resolve(next()),
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        rec.updates.push({ set });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    query: {
      organizationMembers: {
        findFirst: (_opts: unknown) => Promise.resolve(next()[0]),
      },
    },
  };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return db;
}

const auditStub = { log: jest.fn() };

const batchRow = (over: Record<string, unknown> = {}) => ({
  id: 10,
  orgId: "org1",
  entityId: null,
  runId: 5,
  periodKey: "2025-07",
  version: 1,
  status: "POSTED",
  reconciliationStatus: "UNRECONCILED",
  reversalOfBatchId: null,
  reversalReason: null,
  provisional: false,
  sourceHash: "hash-abc",
  totalDebits: "1000.00",
  totalCredits: "1000.00",
  lineCount: 2,
  unmappedCodes: [],
  note: null,
  reconciliationNote: null,
  postedAt: new Date("2025-07-31T00:00:00Z"),
  exportedAt: null,
  reversedAt: null,
  reconciledAt: null,
  createdAt: new Date("2025-07-31T00:00:00Z"),
  ...over,
});

function build(queue: unknown[][], journal?: Partial<Record<string, unknown>>) {
  const rec: Recorded = { inserts: [], updates: [] };
  const db = makeDb(queue, rec);
  const journalService = {
    buildJournal: jest.fn().mockResolvedValue({
      provisional: false,
      month: "2025-07",
      lines: [
        { account: "Salary Expense", description: "Basic (BASIC)", debit: 1000, credit: 0, costCenter: "CC1" },
        { account: "Salaries Payable", description: "Net payable", debit: 0, credit: 1000, costCenter: null },
      ],
      unmappedCodes: [],
      totalDebits: 1000,
      totalCredits: 1000,
      ...journal,
    }),
  };
  const service = new JournalOutboxService(
    db as never,
    journalService as never,
    auditStub as never,
  );
  return { service, rec, journalService };
}

beforeEach(() => auditStub.log.mockClear());

describe("journal outbox — reversal", () => {
  it("writes a contra batch with debits and credits swapped and never edits the original lines", async () => {
    const original = batchRow();
    const { service, rec } = build([
      [original],                       // requireBatch
      [{ ...original, lineNo: 1, account: "Salary Expense", description: "Basic (BASIC)", debit: "1000.00", credit: "0.00", costCenter: "CC1" },
       { ...original, lineNo: 2, account: "Salaries Payable", description: "Net payable", debit: "0.00", credit: "1000.00", costCenter: null }],
      [{ id: 1 }],                      // resolveMembershipId
      [{ maxVersion: 1 }],              // version lookup
      [{ id: 11 }],                     // reversal batch insert returning
      [batchRow({ id: 11, reversalOfBatchId: 10, totalDebits: "1000.00", totalCredits: "1000.00" })], // final get
      [],                               // final get lines
    ]);

    await service.reverseBatch("org1", "u1", 10, "Wrong cost centre mapping");

    const lineInsert = rec.inserts.find((i) => Array.isArray(i.values) && (i.values as unknown[]).length === 2);
    expect(lineInsert).toBeDefined();
    const lines = lineInsert!.values as { debit: string; credit: string; description: string }[];
    expect(lines[0]).toMatchObject({ debit: "0.00", credit: "1000.00" });
    expect(lines[1]).toMatchObject({ debit: "1000.00", credit: "0.00" });
    expect(lines[0]!.description).toContain("Reversal —");

    // Original is only ever status-flipped, never re-valued.
    const flip = rec.updates.find((u) => u.set.status === "REVERSED");
    expect(flip).toBeDefined();
    expect(flip!.set).toMatchObject({ status: "REVERSED", reversedBy: "u1" });
    expect(flip!.set).not.toHaveProperty("totalDebits");

    expect(auditStub.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.journal_batch_reversed" }),
    );
  });

  it("refuses to reverse a reversal", async () => {
    const { service } = build([[batchRow({ reversalOfBatchId: 9 })]]);
    await expect(service.reverseBatch("org1", "u1", 10, "again")).rejects.toThrow(BadRequestException);
  });

  it("refuses to reverse a draft batch", async () => {
    const { service } = build([[batchRow({ status: "DRAFT" })]]);
    await expect(service.reverseBatch("org1", "u1", 10, "nope")).rejects.toThrow(BadRequestException);
  });
});

describe("journal outbox — lifecycle guards", () => {
  it("refuses to post an unbalanced batch", async () => {
    const { service } = build([[batchRow({ status: "DRAFT", totalDebits: "1000.00", totalCredits: "900.00" })]]);
    await expect(service.markPosted("org1", "u1", 10)).rejects.toThrow(/does not balance/);
  });

  it("refuses to post an already-posted batch", async () => {
    const { service } = build([[batchRow({ status: "POSTED" })]]);
    await expect(service.markPosted("org1", "u1", 10)).rejects.toThrow(BadRequestException);
  });

  it("refuses to export a batch that was never posted", async () => {
    const { service } = build([[batchRow({ status: "DRAFT" })]]);
    await expect(service.markExported("org1", "u1", 10)).rejects.toThrow(BadRequestException);
  });

  it("refuses to reconcile a draft batch", async () => {
    const { service } = build([[batchRow({ status: "DRAFT" })]]);
    await expect(
      service.reconcile("org1", "u1", 10, { status: "RECONCILED" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("clears the reconciled stamp when moving back to UNRECONCILED", async () => {
    const { service, rec } = build([
      [batchRow({ status: "POSTED" })],
      [batchRow({ status: "POSTED" })],
      [],
    ]);
    await service.reconcile("org1", "u1", 10, { status: "UNRECONCILED" });
    expect(rec.updates[0]!.set).toMatchObject({
      reconciliationStatus: "UNRECONCILED",
      reconciledAt: null,
      reconciledBy: null,
    });
  });

  it("404s on a batch belonging to another org", async () => {
    const { service } = build([[]]);
    await expect(service.get("org1", 999)).rejects.toThrow(NotFoundException);
  });
});

describe("journal outbox — creation", () => {
  it("refuses to snapshot an unlocked run unless provisional is explicit", async () => {
    const { service } = build([[{ id: 5, orgId: "org1", month: "2025-07", status: "DRAFT", runType: "REGULAR" }]]);
    await expect(
      service.createBatch("org1", "u1", { periodKey: "2025-07" }),
    ).rejects.toThrow(/not approved or locked/);
  });

  it("returns the existing batch instead of duplicating an unchanged journal", async () => {
    const existing = batchRow({ id: 42 });
    const { service, rec } = build([
      [{ id: 5, orgId: "org1", month: "2025-07", status: "LOCKED", runType: "REGULAR" }], // run
      [{ id: 1 }],  // resolveMembershipId
      [existing],   // source-hash lookup hits
      [existing],   // final get
      [],           // final get lines
    ]);

    const result = await service.createBatch("org1", "u1", { periodKey: "2025-07" });
    expect(result.id).toBe(42);
    expect(rec.inserts).toHaveLength(0);
  });

  it("refuses to snapshot an empty journal", async () => {
    const { service } = build(
      [[{ id: 5, orgId: "org1", month: "2025-07", status: "LOCKED", runType: "REGULAR" }]],
      { lines: [], totalDebits: 0, totalCredits: 0 },
    );
    await expect(
      service.createBatch("org1", "u1", { periodKey: "2025-07" }),
    ).rejects.toThrow(/no lines to post/);
  });
});
