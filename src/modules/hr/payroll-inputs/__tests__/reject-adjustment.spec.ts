import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PayrollInputsService } from "../payroll-inputs.service";

function makeService(adj: unknown) {
  const findFirst = jest.fn().mockResolvedValue(adj);
  const returning = jest.fn().mockResolvedValue([{ id: 1, status: "rejected", rejectionReason: "bad data" }]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const db = {
    query: { hrPayrollAdjustments: { findFirst } },
    update,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const hrAutomation = {} as never;
  const buildService = {} as never;
  const snapshots = {} as never;
  const service = new PayrollInputsService(db as never, audit as never, hrAutomation, buildService, snapshots);
  return { service, update, audit, findFirst };
}

describe("PayrollInputsService.rejectAdjustment", () => {
  it("rejects a pending adjustment with reason", async () => {
    const { service, update, audit } = makeService({ id: 1, status: "pending" });

    const result = await service.rejectAdjustment("org-a", "admin", 1, "Duplicate entry");

    expect(result).toMatchObject({ status: "rejected" });
    expect(update).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "adjustment.rejected" }),
    );
  });

  it("throws when adjustment is missing", async () => {
    const { service } = makeService(undefined);
    await expect(service.rejectAdjustment("org-a", "admin", 99, "n/a")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("throws when adjustment is not pending", async () => {
    const { service } = makeService({ id: 1, status: "approved" });
    await expect(service.rejectAdjustment("org-a", "admin", 1, "n/a")).rejects.toThrow(
      BadRequestException,
    );
  });
});
