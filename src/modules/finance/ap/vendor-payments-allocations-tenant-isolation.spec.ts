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

describe("VendorPaymentsAllocationsService — cross-tenant isolation", () => {
  it("throws NotFoundException when payment belongs to a different org (BOLA isolation)", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectOnce([])),
    } as unknown as Db;
    const audit = { log: jest.fn() } as any;
    const svc = new VendorPaymentsAllocationsService(db, audit);

    await expect(
      svc.allocate("org-attacker", "user-1", { vendorPaymentId: 99, allocations: [] }),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not throw NotFoundException for the owning org (same-tenant control)", async () => {
    const payment = { id: 99, orgId: "org-owner", amount: "500.00", amountAllocated: "0.00" };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return makeSelectOnce([payment]);
        return makeSelectDirect([{ total: "0" }]);
      }),
      transaction: jest.fn().mockResolvedValue(undefined),
    } as unknown as Db;
    const audit = { log: jest.fn() } as never;
    const svc = new VendorPaymentsAllocationsService(db, audit);

    await expect(
      svc.allocate("org-owner", "user-1", { vendorPaymentId: 99, allocations: [] }),
    ).resolves.not.toThrow();
  });
});
