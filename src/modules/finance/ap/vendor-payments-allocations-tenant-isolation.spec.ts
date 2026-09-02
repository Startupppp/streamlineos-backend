import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { VendorPaymentsAllocationsService } from "./vendor-payments-allocations.service";

function makeSelectOnce(result: unknown[]): Record<string, jest.Mock> {
  const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(result) });
  return { from: jest.fn().mockReturnValue({ where }) };
}

function makeSelectDirect(result: unknown[]): Record<string, jest.Mock> {
  const where = jest.fn().mockResolvedValue(result);
  return { from: jest.fn().mockReturnValue({ where }) };
}

function makeTx() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue(undefined);
  return { insert, values, onConflictDoUpdate, execute };
}

describe("VendorPaymentsAllocationsService — cross-tenant isolation", () => {
  const audit = { log: jest.fn() } as never;

  it("throws NotFoundException when payment belongs to a different org (BOLA isolation)", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectOnce([])),
      transaction: jest.fn(),
    };
    const svc = new VendorPaymentsAllocationsService(db as unknown as Db, audit);

    await expect(
      svc.allocate("org-attacker", "user-1", { vendorPaymentId: 99, allocations: [] }),
    ).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("reaches the transaction for the owning org and writes nothing when there is nothing to allocate", async () => {
    const payment = { id: 99, orgId: "org-owner", amount: "500.00", amountAllocated: "0.00" };
    let call = 0;
    const tx = makeTx();
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return makeSelectOnce([payment]);
        return makeSelectDirect([{ total: "0" }]);
      }),
      transaction: jest
        .fn()
        .mockImplementation((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const svc = new VendorPaymentsAllocationsService(db as unknown as Db, audit);

    await expect(
      svc.allocate("org-owner", "user-1", { vendorPaymentId: 99, allocations: [] }),
    ).resolves.toEqual({ vendorPaymentId: 99, allocated: 0 });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("collapses duplicate bill lines and settles the bill balance inside the transaction", async () => {
    const payment = { id: 99, orgId: "org-owner", amount: "500.00", amountAllocated: "0.00" };
    const bill = { id: 7, orgId: "org-owner", total: "300.00", amountPaid: "0.00", status: "OPEN" };
    let call = 0;
    const tx = makeTx();
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return makeSelectOnce([payment]);
        if (call === 2) return makeSelectDirect([{ total: "0" }]);
        return makeSelectOnce([bill]);
      }),
      transaction: jest
        .fn()
        .mockImplementation((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const svc = new VendorPaymentsAllocationsService(db as unknown as Db, audit);

    await expect(
      svc.allocate("org-owner", "user-1", {
        vendorPaymentId: 99,
        allocations: [
          { billId: 7, amount: 100 },
          { billId: 7, amount: 20 },
        ],
      }),
    ).resolves.toEqual({ vendorPaymentId: 99, allocated: 2 });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.values).toHaveBeenCalledWith([
      { orgId: "org-owner", vendorPaymentId: 99, billId: 7, amount: "120.0000" },
    ]);
    expect(tx.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});
