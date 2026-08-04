import { BadRequestException } from "@nestjs/common";
import {
  monthlyAmountToCents,
  syncCanonicalSensitiveFields,
} from "./sync-canonical-sensitive-fields";

describe("canonical sensitive-field dual write", () => {
  it("converts exact currency units to integer cents", () => {
    expect(monthlyAmountToCents(1234.56)).toBe(123456);
    expect(monthlyAmountToCents(0)).toBe(0);
    expect(() => monthlyAmountToCents(1.001)).toThrow(BadRequestException);
    expect(() => monthlyAmountToCents(Number.POSITIVE_INFINITY)).toThrow(BadRequestException);
  });

  it("updates an existing tenant-scoped sensitive record without inserting", async () => {
    const employmentWhere = jest.fn(() => ({ sql: "employment-subquery" }));
    const returning = jest.fn().mockResolvedValue([{ id: 4 }]);
    const sensitiveWhere = jest.fn((_predicate: unknown) => ({ returning }));
    const set = jest.fn(() => ({ where: sensitiveWhere }));
    const db = {
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: employmentWhere }) }),
      }),
      update: () => ({ set }),
      insert: jest.fn(),
    };

    await expect(
      syncCanonicalSensitiveFields(db as never, "org-1", "user-1", {
        monthlySalary: 2500.5,
      }),
    ).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ salaryAmountCents: 250050 }),
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("reports missing canonical backfill and never invents a row", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const db = {
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: () => ({ sql: "employment-subquery" }) }) }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
      insert: jest.fn(),
    };
    await expect(
      syncCanonicalSensitiveFields(db as never, "org-1", "user-1", {
        monthlySalary: 100,
      }),
    ).resolves.toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
