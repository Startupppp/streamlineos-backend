import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { JournalService } from "../journal.service";
import { AccountingMappingsService } from "../accounting-mappings.service";
import { ReportsService } from "../reports.service";

function chain(data: unknown) {
  const c: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(data),
  };
  for (const method of ["limit", "offset", "orderBy", "groupBy", "having"]) {
    c[method] = () => c;
  }
  return c;
}

function makeLineItem(overrides: {
  id?: number;
  runId?: number;
  runEmployeeId?: number;
  componentId?: number | null;
  code?: string;
  category?: string;
  name?: string;
  amount?: string;
}): Record<string, unknown> {
  return {
    id: overrides.id ?? 1,
    runId: overrides.runId ?? 10,
    runEmployeeId: overrides.runEmployeeId ?? 100,
    componentId: overrides.componentId ?? null,
    code: overrides.code ?? "BASIC",
    category: overrides.category ?? "EARNING",
    name: overrides.name ?? "Basic",
    amount: overrides.amount ?? "1000.00",
    orgId: "org1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function _makeRunEmployee(net: string, id = 100): Record<string, unknown> {
  return { id, net, runId: 10, orgId: "org1", userId: "u1", profileId: 1 };
}

function _makeMockDb(lineItems: unknown[], runEmployees: unknown[], costCenters: unknown[]) {
  const selectFns = {
    lineItems,
    runEmployees,
    costCenters,
  };

  let callCount = 0;
  const whereReturns = [lineItems, runEmployees, costCenters];

  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(() => {
      const result = whereReturns[callCount] ?? [];
      callCount++;
      return Promise.resolve(result);
    }),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    query: {},
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    _selectFns: selectFns,
  };
}

describe("JournalService — double-entry balancing", () => {
  it("debits === credits when no employer contributions", async () => {
    const mappings = new Map<string, string>([["EARNING", "Salaries Expense"]]);
    const mockMappingsService = { getMappings: jest.fn().mockResolvedValue(mappings) };

    const lineItems = [
      makeLineItem({ category: "EARNING", amount: "5000.00", code: "BASIC", name: "Basic" }),
      makeLineItem({ id: 2, category: "DEDUCTION", amount: "600.00", code: "PF_EMP", name: "PF Employee" }),
    ];
    const runEmployees = [{ net: "4400.00" }];
    const costCenters = [{ runEmployeeId: 100, costCenter: null }];

    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1" };

    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn()
        .mockReturnValueOnce(chain([run]))
        .mockReturnValueOnce(chain(lineItems))
        .mockReturnValueOnce(chain(runEmployees))
        .mockReturnValueOnce(chain(costCenters)),
      leftJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    };

    const service = new JournalService(db as never, mockMappingsService as never);
    const result = await service.buildJournal("org1", "2026-07");

    expect(result.totalDebits).toBe(result.totalCredits);
  });

  it("debits === credits with EMPLOYER_CONTRIBUTION present", async () => {
    const mappings = new Map<string, string>([
      ["EARNING", "Salaries Expense"],
      ["EMPLOYER_CONTRIBUTION", "Employer PF Expense"],
    ]);
    const mockMappingsService = { getMappings: jest.fn().mockResolvedValue(mappings) };

    const lineItems = [
      makeLineItem({ category: "EARNING", amount: "10000.00", code: "BASIC", name: "Basic" }),
      makeLineItem({ id: 2, category: "DEDUCTION", amount: "1200.00", code: "PF_EMP", name: "PF Employee" }),
      makeLineItem({ id: 3, category: "EMPLOYER_CONTRIBUTION", amount: "1300.00", code: "PF_ER", name: "PF Employer" }),
    ];
    const runEmployees = [{ net: "8800.00" }];
    const costCenters = [{ runEmployeeId: 100, costCenter: null }];

    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1" };

    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn()
        .mockReturnValueOnce(chain([run]))
        .mockReturnValueOnce(chain(lineItems))
        .mockReturnValueOnce(chain(runEmployees))
        .mockReturnValueOnce(chain(costCenters)),
      leftJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    };

    const service = new JournalService(db as never, mockMappingsService as never);
    const result = await service.buildJournal("org1", "2026-07");

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(typeof result.totalDebits).toBe("number");
    expect(typeof result.totalCredits).toBe("number");
  });

  it("emits debit/credit as numbers, not strings", async () => {
    const mappings = new Map<string, string>();
    const mockMappingsService = { getMappings: jest.fn().mockResolvedValue(mappings) };

    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1" };
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn()
        .mockReturnValueOnce(chain([run]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([{ net: "1000.00" }]))
        .mockReturnValueOnce(chain([])),
      leftJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    };

    const service = new JournalService(db as never, mockMappingsService as never);
    const result = await service.buildJournal("org1", "2026-07");

    for (const line of result.lines) {
      expect(typeof line.debit).toBe("number");
      expect(typeof line.credit).toBe("number");
    }
  });
});

describe("AccountingMappingsService — create XOR validation", () => {
  const mockDb = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnValue(chain([{ id: 1 }])),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 99, ledgerName: "Test" }]),
    delete: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  };

  const service = new AccountingMappingsService(mockDb as never);

  it("rejects when neither componentId nor category is provided", async () => {
    await expect(
      service.create("org1", { ledgerName: "Test Ledger" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects when both componentId and category are provided", async () => {
    await expect(
      service.create("org1", { componentId: 1, category: "EARNING", ledgerName: "Test Ledger" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("succeeds with componentId only", async () => {
    mockDb.where.mockReturnValueOnce(chain([{ id: 1 }]));
    mockDb.returning.mockResolvedValueOnce([{ id: 99, ledgerName: "Test Ledger", componentId: 1 }]);
    const result = await service.create("org1", { componentId: 1, ledgerName: "Test Ledger" });
    expect(result.id).toBe(99);
  });

  it("succeeds with category only", async () => {
    mockDb.returning.mockResolvedValueOnce([{ id: 100, ledgerName: "Test Ledger", category: "EARNING" }]);
    const result = await service.create("org1", { category: "EARNING", ledgerName: "Test Ledger" });
    expect(result.id).toBe(100);
  });
});

describe("ReportsService — pagination cap", () => {
  const mockDb = {
    select: jest.fn().mockReturnThis(),
    selectDistinct: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  };

  const service = new ReportsService(mockDb as never);

  it("caps limit at 100 for getBankPayout — batches query returns empty", async () => {
    mockDb.where.mockReset();
    mockDb.where
      .mockReturnValueOnce(chain([{ id: 10, status: "LOCKED", month: "2026-07", orgId: "org1", runType: "REGULAR" }]))
      .mockReturnValueOnce(chain([]));

    const result = await service.getBankPayout("org1", "2026-07", { limit: 999, offset: 0 });
    expect(result.batches.length).toBeLessThanOrEqual(100);
  });

  it("respects offset for getVariance perEmployee", async () => {
    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1", grossTotal: "10000.00", netTotal: "9000.00", runType: "REGULAR" };
    mockDb.where.mockReset();
    mockDb.where
      .mockReturnValueOnce(chain([run]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));

    const result = await service.getVariance("org1", "2026-07", { limit: 10, offset: 100 });
    expect(result.perEmployee).toHaveLength(0);
  });
});

describe("ReportsService — SQL cap bites at 100", () => {
  function limitedChain(data: unknown[]) {
    let result = [...data];
    const c: Record<string, unknown> = {};
    c["then"] = (resolve: (v: unknown) => void) => resolve(result);
    c["limit"] = (n: number) => { result = result.slice(0, n); return c; };
    c["offset"] = (n: number) => { result = result.slice(n); return c; };
    c["orderBy"] = () => c;
    c["groupBy"] = () => c;
    c["having"] = () => c;
    return c;
  }

  it("getVariance: clamps limit to 100 even when 999 is requested", async () => {
    const run = {
      id: 10, status: "LOCKED", month: "2026-07", orgId: "org1",
      grossTotal: "1000000.00", netTotal: "900000.00", runType: "REGULAR",
    };
    const fakeEmployees = Array.from({ length: 200 }, (_, i) => ({
      userId: `user-${i}`,
      gross: "5000.00",
      net: "4500.00",
      userName: `User ${i}`,
    }));

    const mockDb2 = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn()
        .mockReturnValueOnce(limitedChain([run]))
        .mockReturnValueOnce(limitedChain([]))
        .mockReturnValueOnce(limitedChain(fakeEmployees)),
    };

    const service2 = new ReportsService(mockDb2 as never);
    const result = await service2.getVariance("org1", "2026-07", { limit: 999, offset: 0 });

    expect(result.perEmployee.length).toBe(100);
  });

  it("getBankPayout: clamps limit to 100 when 999 is requested", async () => {
    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1", runType: "REGULAR" };
    const fakeBatches = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      batchNumber: `BATCH-${i}`,
      format: "NEFT",
      totalAmount: "50000.00",
      itemCount: 10,
      status: "GENERATED",
      generatedAt: new Date(),
    }));

    const mockDb3 = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn()
        .mockReturnValueOnce(limitedChain([run]))
        .mockReturnValueOnce(limitedChain(fakeBatches))
        .mockReturnValueOnce(limitedChain([])),
    };

    const service3 = new ReportsService(mockDb3 as never);
    const result = await service3.getBankPayout("org1", "2026-07", { limit: 999, offset: 0 });

    expect(result.batches.length).toBe(100);
  });
});

describe("ReportsService.getCostCenter — costCenter filter is in SQL, not JS post-filter", () => {
  const dialect = new PgDialect();

  it("passes costCenter to WHERE clause so LIMIT/OFFSET operates on filtered rows (bites if filter moves to JS)", async () => {
    let selectCount = 0;
    const capturedAggWhereArgs: unknown[] = [];

    const runRow = {
      id: 10, status: "LOCKED", month: "2026-07", orgId: "org1", runType: "REGULAR",
      grossTotal: "0", netTotal: "0", deductionTotal: "0", employerCostTotal: "0",
      employeeCount: 0, exceptionCount: 0,
    };

    const runChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([runRow]),
    };

    const aggChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation((cond: unknown) => {
        capturedAggWhereArgs.push(cond);
        return aggChain;
      }),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockResolvedValue([]),
    };

    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return selectCount === 1 ? runChain : aggChain;
      }),
    };

    const service = new ReportsService(mockDb as never);
    await service.getCostCenter("org1", "2026-07", { costCenter: "CC-ENG" });

    const allRenderedSql = capturedAggWhereArgs
      .map((cond) => {
        try {
          return dialect.sqlToQuery(cond as SQL).sql;
        } catch {
          return "";
        }
      })
      .join(" ");

    expect(allRenderedSql).toContain("cost_center");
  });
});
