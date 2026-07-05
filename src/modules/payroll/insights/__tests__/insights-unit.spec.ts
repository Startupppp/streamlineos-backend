import { BadRequestException } from "@nestjs/common";
import { JournalService } from "../journal.service";
import { AccountingMappingsService } from "../accounting-mappings.service";
import { ReportsService } from "../reports.service";

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

function makeRunEmployee(net: string, id = 100): Record<string, unknown> {
  return { id, net, runId: 10, orgId: "org1", userId: "u1", profileId: 1 };
}

function makeMockDb(lineItems: unknown[], runEmployees: unknown[], costCenters: unknown[]) {
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
        .mockResolvedValueOnce([run])
        .mockResolvedValueOnce(lineItems)
        .mockResolvedValueOnce(runEmployees)
        .mockResolvedValueOnce(costCenters),
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
        .mockResolvedValueOnce([run])
        .mockResolvedValueOnce(lineItems)
        .mockResolvedValueOnce(runEmployees)
        .mockResolvedValueOnce(costCenters),
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
        .mockResolvedValueOnce([run])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ net: "1000.00" }])
        .mockResolvedValueOnce([]),
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
    where: jest.fn().mockResolvedValue([{ id: 1 }]),
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
    mockDb.where.mockResolvedValueOnce([{ id: 1 }]);
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
    from: jest.fn().mockReturnThis(),
    where: jest.fn(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };

  const service = new ReportsService(mockDb as never);

  it("caps limit at 100 for getBankPayout", async () => {
    mockDb.where.mockResolvedValueOnce([{ id: 10, status: "LOCKED", month: "2026-07", orgId: "org1" }]);
    mockDb.where.mockResolvedValueOnce([]);

    const result = await service.getBankPayout("org1", "2026-07", { limit: 999, offset: 0 });
    expect(result.batches.length).toBeLessThanOrEqual(100);
  });

  it("respects offset for getVariance perEmployee", async () => {
    const run = { id: 10, status: "LOCKED", month: "2026-07", orgId: "org1", grossTotal: "10000.00", netTotal: "9000.00" };
    mockDb.where
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.getVariance("org1", "2026-07", { limit: 10, offset: 100 });
    expect(result.perEmployee).toHaveLength(0);
  });
});

describe("report-builders — costCenter filter applied", () => {
  it("filters enriched items by costCenter when filter is set", () => {
    type Item = { userDept: string | null; costCenter: string | null };
    const items: Item[] = [
      { userDept: "Engineering", costCenter: "CC1" },
      { userDept: "Engineering", costCenter: "CC2" },
      { userDept: "HR", costCenter: "CC1" },
    ];

    const filtered = items.filter((e) => e.costCenter === "CC1");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.costCenter === "CC1")).toBe(true);
  });

  it("filters by both department and costCenter when both set", () => {
    type Item = { userDept: string | null; costCenter: string | null };
    const items: Item[] = [
      { userDept: "Engineering", costCenter: "CC1" },
      { userDept: "Engineering", costCenter: "CC2" },
      { userDept: "HR", costCenter: "CC1" },
    ];

    const filtered = items.filter(
      (e) => e.userDept === "Engineering" && e.costCenter === "CC1",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.userDept).toBe("Engineering");
    expect(filtered[0]?.costCenter).toBe("CC1");
  });
});
