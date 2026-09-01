import { ConflictException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import type { Db } from "../../../db/drizzle.module";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { TaxWindowsService } from "./tax-windows.service";

describe("Payroll insights query bounds", () => {
  it("accounting mappings probes one overflow row and fails instead of truncating", async () => {
    const limit = jest.fn().mockResolvedValue(Array.from({ length: 501 }, (_, id) => ({ id })));
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit }),
          }),
        }),
      }),
    } as unknown as Db;

    await expect(new AccountingMappingsService(db).list("org-1"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(limit).toHaveBeenCalledWith(501);
  });

  it("tax-window history probes overflow and unique create lookup reads one row", async () => {
    const historyLimit = jest.fn().mockResolvedValue(Array.from({ length: 101 }, (_, id) => ({ id })));
    const uniqueLimit = jest.fn().mockResolvedValue([]);
    const select = jest.fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: historyLimit }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: uniqueLimit }),
        }),
      });
    const db = {
      select,
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    } as unknown as Db;
    const service = new TaxWindowsService(db, {} as never);

    await expect(service.list("org-1")).rejects.toBeInstanceOf(ConflictException);
    await service.create("org-1", {
      financialYear: "2026-27",
      opensAt: "2026-04-01T00:00:00.000Z",
      closesAt: "2027-03-31T00:00:00.000Z",
    });

    expect(historyLimit).toHaveBeenCalledWith(101);
    expect(uniqueLimit).toHaveBeenCalledWith(1);
  });

  it("manager inbox fetches at most one latest payslip and declaration per bounded report", () => {
    const source = readFileSync(require.resolve("./manager-inbox.service"), "utf8");
    expect(source).toContain(".limit(directReportIds.length)");
    expect(source.match(/\.selectDistinctOn\(/g)).toHaveLength(2);
    expect(source).toContain("asc(payslipPublications.userId)");
    expect(source).toContain("asc(taxDeclarations.userId)");
  });
});
