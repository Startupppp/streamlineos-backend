import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { PayrollInputsService } from "../payroll-inputs.service";
import { HrAuditService } from "../../core/hr-audit.service";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";
import { PayrollInputsBuildService } from "../payroll-inputs-build.service";
import { PayrollInputSnapshotsService } from "../payroll-input-snapshots.service";
import { PayrollInputAdjustmentsService } from "../payroll-input-adjustments.service";
import { nextMonthKey, periodBoundsFrom } from "../payroll-period-key";
import { hrPayrollInputSectionEnum } from "../../../../db/schema/payroll/input-capture";
import fs from "node:fs";
import path from "node:path";

function _chainable(terminal: unknown = undefined) {
  const obj: Record<string, jest.Mock> = {};
  const methods = ["select", "from", "where", "set", "orderBy", "innerJoin", "offset", "limit", "returning", "catch", "update", "insert", "values", "delete", "groupBy"];
  for (const m of methods) {
    obj[m] = jest.fn().mockReturnValue(obj);
  }
  obj["returning"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["limit"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["offset"] = jest.fn().mockResolvedValue(terminal ?? []);
  obj["catch"] = jest.fn().mockResolvedValue(undefined);
  // Allow `await db.select().from().where(...)` freeze summary queries.
  obj["where"] = jest.fn().mockImplementation(() => {
    const next = Object.create(obj) as Record<string, jest.Mock> & PromiseLike<unknown>;
    for (const m of methods) {
      next[m] = obj[m];
    }
    next.then = ((onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(terminal ?? []).then(onFulfilled, onRejected)) as never;
    return next;
  });
  return obj;
}

const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
const mockAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
const mockBuildService = { buildSnapshots: jest.fn().mockResolvedValue(undefined) };
const mockSnapshotsService = {
  buildFreezeSummary: jest.fn().mockResolvedValue({
    sections: {},
    employeeCount: 0,
    attendanceRows: 0,
    leaveRows: 0,
    overtimeRows: 0,
    compensationRows: 0,
    approvedRegularizations: 0,
  }),
  listSectionSnapshot: jest.fn(),
};
const mockAdjustmentsService = {
  listAdjustments: jest.fn(),
  createAdjustment: jest.fn(),
  approveAdjustment: jest.fn(),
  rejectAdjustment: jest.fn(),
};

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
        { provide: PayrollInputSnapshotsService, useValue: mockSnapshotsService },
        { provide: PayrollInputAdjustmentsService, useValue: mockAdjustmentsService },
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

    await service.buildPeriod("org1", "actor1", 1).catch(() => undefined);

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
        { provide: PayrollInputSnapshotsService, useValue: mockSnapshotsService },
        { provide: PayrollInputAdjustmentsService, useValue: mockAdjustmentsService },
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
        PayrollInputAdjustmentsService,
        { provide: DRIZZLE, useValue: db },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: HrAutomationEngineService, useValue: mockAutomation },
        { provide: PayrollInputsBuildService, useValue: mockBuildService },
        { provide: PayrollInputSnapshotsService, useValue: mockSnapshotsService },
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
        { provide: PayrollInputSnapshotsService, useValue: mockSnapshotsService },
        { provide: PayrollInputAdjustmentsService, useValue: mockAdjustmentsService },
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

/**
 * This block used to declare its own `periodBounds` and `nextMonthKey` inside
 * each `it`, and to assert that a locally-declared eight-element array had
 * eight elements. Nothing it covered could fail: the subject was the copy in
 * the test file, so the real helpers in `payroll-period-key.ts` could have been
 * deleted and every assertion here would still have passed. It also hid a live
 * duplication — `payroll-inputs-build.service.ts` carried a third, private copy
 * of `periodBounds`, byte-identical to `periodBoundsFrom`, which is the one the
 * build path actually ran. The service now imports the shared helper, and this
 * block imports the same one.
 */
describe("payroll-period-key — the helpers the build path actually calls", () => {
  it("periodBoundsFrom computes correct start and end for a given YYYY-MM key", () => {
    expect(periodBoundsFrom("2026-07")).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(periodBoundsFrom("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodBoundsFrom("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodBoundsFrom("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("nextMonthKey correctly advances from December to January of next year", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(nextMonthKey("2026-07")).toBe("2026-08");
    expect(nextMonthKey("2026-01")).toBe("2026-02");
  });

  it("is the only definition of these two shapes left in the payroll-inputs folder", () => {
    const folder = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name === "payroll-period-key.ts") continue;
      const src = fs.readFileSync(path.join(folder, entry.name), "utf8");
      if (/function\s+(periodBounds|nextMonthKey)\b/.test(src)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("hrPayrollInputSectionEnum — the sections the build path writes", () => {
  it("declares eight distinct sections", () => {
    expect(hrPayrollInputSectionEnum.enumValues).toHaveLength(8);
    expect(new Set(hrPayrollInputSectionEnum.enumValues).size).toBe(8);
  });

  it("the build service emits a snapshot for every declared section, and no other", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "payroll-inputs-build.service.ts"),
      "utf8",
    );
    const emitted = [...src.matchAll(/buildSnapshot\("([a-z_]+)"/g)].map((match) => match[1]);
    expect([...emitted].sort()).toEqual([...hrPayrollInputSectionEnum.enumValues].sort());
  });
});
