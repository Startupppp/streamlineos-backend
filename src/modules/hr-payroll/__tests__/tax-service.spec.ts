import { TaxService } from "../tax.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

function makeDb(selectResult: unknown[] = [], updateResult: unknown[] = [], insertResult: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(insertResult);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });

  const insertReturning = jest.fn().mockResolvedValue(insertResult);
  const insertWhere = jest.fn().mockReturnValue({ returning: insertReturning });
  const values = jest.fn().mockReturnValue({ returning: insertReturning, where: insertWhere });
  const insert = jest.fn().mockReturnValue({ values });

  const selectLimit = jest.fn().mockResolvedValue(selectResult);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const select = jest.fn().mockReturnValue({ from: selectFrom });

  return { select, update, insert };
}

describe("TaxService.createOrUpdate", () => {
  it("inserts a new declaration with status SUBMITTED when none exists", async () => {
    const db = makeDb([], [], [{ id: 1, status: "SUBMITTED" }]);
    const service = new TaxService(db as never);

    const result = await service.createOrUpdate("org-1", "user-1", {
      financialYear: "2025-26",
      regime: "NEW",
      status: "SUBMITTED",
    });

    expect(db.select).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    expect(result).toMatchObject({ id: 1, status: "SUBMITTED" });
  });

  it("updates an existing declaration preserving provided status", async () => {
    const db = makeDb([{ id: 42 }], [{ id: 42, status: "SUBMITTED" }], []);
    const returning = jest.fn().mockResolvedValue([{ id: 42, status: "SUBMITTED" }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    db.update = jest.fn().mockReturnValue({ set });

    const service = new TaxService(db as never);

    const result = await service.createOrUpdate("org-1", "user-1", {
      financialYear: "2025-26",
      status: "SUBMITTED",
    });

    expect(db.update).toHaveBeenCalled();
    expect(result).toMatchObject({ id: 42, status: "SUBMITTED" });
  });

  it("persists previousEmploymentIncome and previousEmployerTds on insert", async () => {
    const db = makeDb([], [], [{ id: 2, previousEmploymentIncome: "120000", previousEmployerTds: "8000" }]);
    const service = new TaxService(db as never);

    const result = await service.createOrUpdate("org-1", "user-1", {
      financialYear: "2025-26",
      regime: "OLD",
      previousEmploymentIncome: "120000",
      previousEmployerTds: "8000",
    });

    expect(db.insert).toHaveBeenCalled();
    expect(result).toMatchObject({ previousEmploymentIncome: "120000", previousEmployerTds: "8000" });
  });
});
