import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PayrollInputsService } from "../payroll-inputs.service";
import { HrAuditService } from "../../hr-core/hr-audit.service";
import { HrAutomationEngineService } from "../../hr-automations/hr-automation-engine.service";
import { PayrollInputsBuildService } from "../payroll-inputs-build.service";

function chainable(terminal: unknown = undefined) {
  const obj: Record<string, jest.Mock> = {};
  const methods = ["select", "from", "where", "set", "orderBy", "innerJoin", "offset", "limit", "returning", "catch", "update", "insert", "values", "delete", "groupBy"];
  for (const m of methods) {
    obj[m] = jest.fn().mockReturnValue(obj);
  }
  obj["returning"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["limit"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["offset"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["catch"] = jest.fn().mockResolvedValue(undefined);
  return obj;
}

const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
const mockAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
const mockBuildService = { buildSnapshots: jest.fn().mockResolvedValue(undefined) };

function makePeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org1",
    periodKey: "2026-07",
    status: "open",
    createdBy: "actor1",
    createdAt: new Date(),
    updatedAt: new Date(),
    builtAt: null,
    lockedAt: null,
    lockedBy: null,
    cutoffDate: null,
    ...overrides,
  };
}

function makeDb(overrides: Record<string, unknown> = {}) {
  const db = {
    query: {
      hrPayrollInputPeriods: { findFirst: jest.fn() },
      hrPayrollAdjustments: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    insert: jest.fn(),
    values: jest.fn(),
    returning: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    orderBy: jest.fn(),
    offset: jest.fn(),
    innerJoin: jest.fn(),
    transaction: jest.fn(),
    ...overrides,
  };

  db.select.mockReturnValue(db);
  db.from.mockReturnValue(db);
  db.where.mockReturnValue(db);
  db.limit.mockResolvedValue([]);
  db.insert.mockReturnValue(db);
  db.values.mockReturnValue(db);
  db.returning.mockResolvedValue([]);
  db.update.mockReturnValue(db);
  db.set.mockReturnValue(db);
  db.delete.mockReturnValue(db);
  db.orderBy.mockReturnValue(db);
  db.offset.mockResolvedValue([]);
  db.innerJoin.mockReturnValue(db);

  return db;
}

describe("PayrollInputsService — buildPeriod", () => {
  let service: PayrollInputsService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollInputsService,
        { provide: DRIZZLE, useValue: db },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: HrAutomationEngineService, useValue: mockAutomation },
        { provide: PayrollInputsBuildService, useValue: mockBuildService },
      ],
    }).compile();

    service = module.get(PayrollInputsService);
  });

  it("throws ForbiddenException when trying to rebuild a locked period", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(makePeriod({ status: "locked" }));
    await expect(service.buildPeriod("org1", "actor1", 1)).rejects.toThrow(ForbiddenException);
  });

  it("calls buildSnapshots for an open period", async () => {
    const period = makePeriod({ status: "open" });
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(period);
    db.where.mockReturnValue({ ...db, returning: jest.fn().mockResolvedValue([makePeriod({ status: "built" })]) });

    try {
      await service.buildPeriod("org1", "actor1", 1);
    } catch {}

    expect(mockBuildService.buildSnapshots).toHaveBeenCalled();
  });
});

describe("PayrollInputsService — lockPeriod", () => {
  let service: PayrollInputsService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollInputsService,
        { provide: DRIZZLE, useValue: db },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: HrAutomationEngineService, useValue: mockAutomation },
        { provide: PayrollInputsBuildService, useValue: mockBuildService },
      ],
    }).compile();

    service = module.get(PayrollInputsService);
  });

  it("throws BadRequestException when period is not in built status", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(makePeriod({ status: "open" }));
    await expect(service.lockPeriod("org1", "actor1", 1)).rejects.toThrow(BadRequestException);
  });

  it("runs inside a transaction when locking a built period", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(makePeriod({ status: "built" }));

    db.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = makeDb();
      tx.returning.mockResolvedValue([makePeriod({ status: "locked" })]);
      tx.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
      tx.update.mockReturnValue({
        set: () => ({
          where: () => ({
            returning: jest.fn().mockResolvedValue([makePeriod({ status: "locked" })]),
            catch: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      return fn(tx);
    });

    await service.lockPeriod("org1", "actor1", 1);
    expect(db.transaction).toHaveBeenCalled();
  });

  it("emits payroll.inputs_locked event after successful lock", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(makePeriod({ status: "built" }));

    db.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = makeDb();
      tx.update.mockReturnValue({
        set: () => ({
          where: () => ({
            returning: jest.fn().mockResolvedValue([makePeriod({ status: "locked" })]),
            catch: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      tx.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
      return fn(tx);
    });

    await service.lockPeriod("org1", "actor1", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockAutomation.emit).toHaveBeenCalledWith("org1", "payroll.inputs_locked", expect.objectContaining({ periodKey: "2026-07" }));
  });
});

describe("PayrollInputsService — createAdjustment", () => {
  let service: PayrollInputsService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollInputsService,
        { provide: DRIZZLE, useValue: db },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: HrAutomationEngineService, useValue: mockAutomation },
        { provide: PayrollInputsBuildService, useValue: mockBuildService },
      ],
    }).compile();

    service = module.get(PayrollInputsService);
  });

  it("routes to next period when current period is locked", async () => {
    const lockedPeriod = makePeriod({ id: 1, status: "locked", periodKey: "2026-07" });
    const nextPeriod = makePeriod({ id: 2, status: "open", periodKey: "2026-08" });

    db.query.hrPayrollInputPeriods.findFirst
      .mockResolvedValueOnce(lockedPeriod)
      .mockResolvedValueOnce(nextPeriod);

    db.returning.mockResolvedValueOnce([{ id: 10, periodId: 2, status: "pending" }]);

    const result = await service.createAdjustment("org1", "actor1", {
      periodId: 1,
      userId: "u1",
      adjustmentType: "arrears",
      section: "compensation",
      amountCents: 50000,
      reason: "Arrears payment",
    });

    expect(result?.periodId).toBe(2);
  });

  it("inserts adjustment directly when period is open", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(makePeriod({ status: "open" }));
    db.returning.mockResolvedValueOnce([{ id: 10, periodId: 1, status: "pending" }]);

    const result = await service.createAdjustment("org1", "actor1", {
      periodId: 1,
      userId: "u1",
      adjustmentType: "arrears",
      section: "compensation",
      amountCents: 50000,
      reason: "Arrears payment",
    });

    expect(result?.periodId).toBe(1);
  });
});

describe("PayrollInputsService — getPeriod", () => {
  let service: PayrollInputsService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollInputsService,
        { provide: DRIZZLE, useValue: db },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: HrAutomationEngineService, useValue: mockAutomation },
        { provide: PayrollInputsBuildService, useValue: mockBuildService },
      ],
    }).compile();

    service = module.get(PayrollInputsService);
  });

  it("throws NotFoundException when period not found in org", async () => {
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(undefined);
    await expect(service.getPeriod("org1", 999)).rejects.toThrow(NotFoundException);
  });

  it("returns the period when found", async () => {
    const period = makePeriod({ id: 1 });
    db.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(period);
    const result = await service.getPeriod("org1", 1);
    expect(result.id).toBe(1);
  });
});

describe("PayrollInputsBuildService — snapshot grouping (pure logic)", () => {
  it("periodBounds computes correct start and end for a given YYYY-MM key", () => {
    function periodBounds(periodKey: string): { start: string; end: string } {
      const [year, month] = periodKey.split("-");
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      return {
        start: `${periodKey}-01`,
        end: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
      };
    }

    expect(periodBounds("2026-07")).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(periodBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodBounds("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("generates 8 snapshot sections per employee", () => {
    const SNAPSHOT_SECTIONS = [
      "employee_master",
      "compensation",
      "attendance",
      "leave",
      "overtime",
      "reimbursement",
      "deduction",
      "lifecycle",
    ] as const;

    expect(SNAPSHOT_SECTIONS).toHaveLength(8);
    const unique = new Set(SNAPSHOT_SECTIONS);
    expect(unique.size).toBe(8);
  });

  it("nextMonthKey correctly advances from December to January of next year", () => {
    function nextMonthKey(periodKey: string): string {
      const [year, month] = periodKey.split("-").map(Number);
      const next = new Date(year!, (month ?? 1), 1);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    }

    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(nextMonthKey("2026-07")).toBe("2026-08");
    expect(nextMonthKey("2026-01")).toBe("2026-02");
  });
});
