import { GoneException } from "@nestjs/common";
import { BankTransfersService } from "../bank-transfers.service";

describe("BankTransfersService — legacy write disabled (Phase 0)", () => {
  it("rejects create with GoneException and never inserts", async () => {
    const insert = jest.fn();
    const db = { insert } as never;
    const service = new BankTransfersService(db);

    await expect(
      service.create("org-a", "user-a", {
        month: "2025-06",
        totalAmount: 1000,
        employeeCount: 1,
        entries: [],
      } as never),
    ).rejects.toThrow(GoneException);

    expect(insert).not.toHaveBeenCalled();
  });

  it("still allows list for migration/read-only surface", async () => {
    const orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 1 }]) });
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = { select } as never;
    const service = new BankTransfersService(db);

    const rows = await service.list("org-a");
    expect(rows).toEqual([{ id: 1 }]);
    expect(select).toHaveBeenCalled();
  });
});
