import { BatchStatusService } from "../batch-status.service";

jest.mock("../lib/payout-run-completion", () => ({
  checkRunCompletion: jest.fn().mockResolvedValue(undefined),
  refreshBatchPaidStatus: jest.fn().mockResolvedValue(undefined),
}));

const { refreshBatchPaidStatus } = jest.requireActual<
  typeof import("../lib/payout-run-completion")
>("../lib/payout-run-completion");

type ItemRow = {
  id: number;
  userId: string | null;
  status: "PENDING" | "SENT" | "PAID" | "FAILED" | "HELD";
};

interface UpdateRecord {
  set: Record<string, unknown>;
}

/**
 * `refreshBatchPaidStatus` reads one grouped count and conditionally writes one
 * status, so the double it needs is a `select().from().where().groupBy()` chain
 * and an `update().set().where()` chain that records what it was asked to write.
 */
function makeStatusDb(groups: Array<{ status: string; n: number }>) {
  const updates: UpdateRecord[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue(groups),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((set: Record<string, unknown>) => {
        updates.push({ set });
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    }),
  };
  return { db, updates };
}

describe("refreshBatchPaidStatus", () => {
  it("marks a batch PAID only when every item is PAID", async () => {
    const { db, updates } = makeStatusDb([{ status: "PAID", n: 3 }]);

    await refreshBatchPaidStatus(db as never, "org-1", 7);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toEqual({ status: "PAID" });
  });

  it("marks a batch FAILED when every item was returned by the bank", async () => {
    const { db, updates } = makeStatusDb([{ status: "FAILED", n: 3 }]);

    await refreshBatchPaidStatus(db as never, "org-1", 7);

    expect(updates[0]?.set).toEqual({ status: "FAILED" });
  });

  it("never reports a batch carrying a FAILED item as PAID", async () => {
    const { db, updates } = makeStatusDb([
      { status: "PAID", n: 2 },
      { status: "FAILED", n: 1 },
    ]);

    await refreshBatchPaidStatus(db as never, "org-1", 7);

    expect(updates[0]?.set).toEqual({ status: "PARTIALLY_PAID" });
  });

  it("leaves a batch that has not been acted on at all untouched", async () => {
    const { db, updates } = makeStatusDb([{ status: "SENT", n: 4 }]);

    await refreshBatchPaidStatus(db as never, "org-1", 7);

    expect(updates).toHaveLength(0);
  });
});

/**
 * `importBankReturn` routes each parsed CSV line onto `markItemPaid` or
 * `markItemFailed`. Those two are the money-moving calls, so the double stubs
 * them and the assertions are on which item id each was asked to act on.
 */
function makeImportService(items: ItemRow[], batchStatus = "SENT") {
  const db = {
    query: {
      payrollBankBatches: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 7, status: batchStatus, runId: 100 }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(items),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  };

  const service = new BatchStatusService(
    db as never,
    { log: jest.fn() } as never,
    { emit: jest.fn() } as never,
    undefined,
  );

  const paid = jest.fn().mockResolvedValue({ success: true });
  const failed = jest.fn().mockResolvedValue({ success: true });
  service.markItemPaid = paid as never;
  service.markItemFailed = failed as never;

  return { service, paid, failed };
}

describe("importBankReturn", () => {
  it("routes a PAID line to the item it names and a FAILED line to its own", async () => {
    const { service, paid, failed } = makeImportService([
      { id: 11, userId: "u1", status: "SENT" },
      { id: 12, userId: "u2", status: "SENT" },
    ]);

    const result = await service.importBankReturn(
      "org-1",
      7,
      "actor-1",
      "itemId,status,transactionRef,failureReason\n11,PAID,UTR-1,\n12,RETURNED,,account closed\n",
    );

    expect(paid).toHaveBeenCalledTimes(1);
    expect(paid.mock.calls[0]?.[2]).toBe(11);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[2]).toBe(12);
    expect(result).toMatchObject({ paid: 1, failed: 1, skipped: 0 });
  });

  it("never re-pays an item the bank already confirmed — a replayed return file is a no-op", async () => {
    const { service, paid, failed } = makeImportService([
      { id: 11, userId: "u1", status: "PAID" },
    ]);

    const result = await service.importBankReturn(
      "org-1",
      7,
      "actor-1",
      "itemId,status,transactionRef\n11,PAID,UTR-1\n",
    );

    expect(paid).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ paid: 0, skipped: 1 });
  });

  it("reports a line naming a payee who is not in the batch instead of applying it somewhere", async () => {
    const { service, paid } = makeImportService([
      { id: 11, userId: "u1", status: "SENT" },
    ]);

    const result = await service.importBankReturn(
      "org-1",
      7,
      "actor-1",
      "userId,status,transactionRef\nu-nobody,PAID,UTR-9\n",
    );

    expect(paid).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]?.message).toContain("No matching item");
  });

  it("matches a userId line onto that payee's non-terminal item, never their settled one", async () => {
    const { service, paid } = makeImportService([
      { id: 11, userId: "u1", status: "FAILED" },
      { id: 12, userId: "u1", status: "SENT" },
    ]);

    await service.importBankReturn(
      "org-1",
      7,
      "actor-1",
      "userId,status,transactionRef\nu1,PAID,UTR-2\n",
    );

    expect(paid).toHaveBeenCalledTimes(1);
    expect(paid.mock.calls[0]?.[2]).toBe(12);
  });

  it("refuses a return file for a batch that was never sent to the bank", async () => {
    const { service } = makeImportService([], "GENERATED");

    await expect(
      service.importBankReturn("org-1", 7, "actor-1", "itemId,status\n11,PAID\n"),
    ).rejects.toThrow("Mark the batch as sent");
  });
});
