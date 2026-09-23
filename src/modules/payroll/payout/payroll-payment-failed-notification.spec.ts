import { BatchStatusService } from "./batch-status.service";
import type { Db } from "../../../db/drizzle.types";

jest.mock("./lib/payout-run-completion", () => ({
  refreshBatchPaidStatus: jest.fn().mockResolvedValue(undefined),
  checkRunCompletion: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-1";
const BATCH_ID = 7;
const ITEM_ID = 42;
const EMPLOYEE = "user-employee";
const ACTOR = "user-payroll-admin";

function makeService(
  itemOverrides: Record<string, unknown> = {},
  emit: jest.Mock = jest.fn().mockResolvedValue(undefined),
) {
  const item = {
    id: ITEM_ID,
    batchId: BATCH_ID,
    orgId: ORG,
    userId: EMPLOYEE,
    status: "SENT",
    amount: "84250.00",
    ...itemOverrides,
  };
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  };
  const db = {
    query: {
      payrollBankBatchItems: { findFirst: jest.fn().mockResolvedValue(item) },
      payrollBankBatches: { findFirst: jest.fn().mockResolvedValue({ runId: 3 }) },
    },
    transaction: jest
      .fn()
      .mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
  } as unknown as Db;

  const audit = { log: jest.fn() } as never;
  const service = new BatchStatusService(db, audit, { emit } as never, undefined);
  return { service, emit, tx };
}

describe("markItemFailed dispatches payroll.payment.failed", () => {
  it("notifies the affected employee when a bank return marks their payment failed", async () => {
    const { service, emit } = makeService();

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["eventKey"]).toBe("payroll.payment.failed");
    expect(payload["orgId"]).toBe(ORG);
    expect(payload["targetUserIds"]).toEqual([EMPLOYEE]);
  });

  it("carries the failure reason so the employee knows why the payment did not land", async () => {
    const { service, emit } = makeService();

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    const payload = emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(payload["message"])).toContain("Account closed");
  });

  it("never puts the payout amount in the notification message or metadata", async () => {
    const { service, emit } = makeService();

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    const payload = emit.mock.calls[0]?.[0] as Record<string, unknown>;
    const serialised = JSON.stringify({
      title: payload["title"],
      message: payload["message"],
      metadata: payload["metadata"],
    });
    expect(serialised).not.toContain("84250");
  });

  it("deduplicates per batch item so a replayed bank return does not notify twice", async () => {
    const { service, emit } = makeService();

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    const payload = emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["dedupeKey"]).toBe(`payroll-bank-item-failed:${ITEM_ID}`);
  });

  it("passes the acting admin so the pipeline does not notify them about their own action", async () => {
    const { service, emit } = makeService();

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    const payload = emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["actorUserId"]).toBe(ACTOR);
  });

  it("dispatches nothing when the batch item has no linked user", async () => {
    const { service, emit } = makeService({ userId: null });

    await service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR);

    expect(emit).not.toHaveBeenCalled();
  });

  it("still marks the item failed when the notification pipeline throws", async () => {
    const emit = jest.fn().mockRejectedValue(new Error("dispatch down"));
    const { service, tx } = makeService({}, emit);

    await expect(
      service.markItemFailed(ORG, BATCH_ID, ITEM_ID, "Account closed", ACTOR),
    ).resolves.toEqual({ success: true });
    expect(tx.update).toHaveBeenCalled();
  });
});
