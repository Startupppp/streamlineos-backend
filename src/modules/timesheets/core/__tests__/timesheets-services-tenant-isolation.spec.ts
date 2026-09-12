import type { Db } from "../../../../db/drizzle.module";
import { FxService } from "../fx.service";
import { BooksService } from "../../../accounting/kernel/books.service";
import { FxService as AccountingFxService } from "../../../accounting/kernel/fx.service";
import type { PackRegistry } from "../../../accounting/packs/pack.registry";
import { EntriesPeriodService } from "../entries-period.service";
import { ExceptionsDetectorService } from "../exceptions-detector.service";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import { BudgetsService } from "../budgets.service";
import { RatesService } from "../rates.service";
import { RateResolverService } from "../rate-resolver.service";
import { EntriesReadService } from "../entries-read.service";
import { TeamService } from "../team.service";
import { EntriesService } from "../entries.service";
import { TimesheetExceptionsService } from "../exceptions.service";
import { TimerService } from "../timer.service";
import { PayrollExportService } from "../../payroll/payroll-export.service";
import { PayrollSettingsService } from "../../payroll/payroll-settings.service";
import { PayrollSummaryService } from "../../payroll/payroll-summary.service";
import { ScopedRead } from "../../../access/scoped-read";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeBuilder(rows: unknown[]) {
  const limit = jest.fn();
  const offset = jest.fn();
  const orderBy = jest.fn();
  const leftJoin = jest.fn();
  const innerJoin = jest.fn();
  const groupBy = jest.fn();
  const where = jest.fn();

  const forFn = jest.fn();
  const builder: Record<string, unknown> & { then: unknown; catch: unknown; finally: unknown } = {
    from: jest.fn(),
    where,
    limit,
    offset,
    orderBy,
    leftJoin,
    innerJoin,
    groupBy,
    for: forFn,
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  where.mockReturnValue(builder);
  orderBy.mockReturnValue(builder);
  leftJoin.mockReturnValue(builder);
  innerJoin.mockReturnValue(builder);
  groupBy.mockReturnValue(builder);
  limit.mockReturnValue(builder);
  offset.mockReturnValue(builder);
  forFn.mockReturnValue(builder);

  return { builder, where };
}

function makeDb(rows: unknown[] = []) {
  const { builder, where } = makeBuilder(rows);
  const queryRows = rows;

  const db = {
    select: jest.fn().mockReturnValue(builder),
    selectDistinctOn: jest.fn().mockReturnValue(builder),
    query: {
      timesheetSettings: {
        findFirst: jest.fn().mockResolvedValue(queryRows[0] ?? null),
        findMany: jest.fn().mockResolvedValue(queryRows),
      },
      timesheetPeriods: {
        findFirst: jest.fn().mockResolvedValue(queryRows[0] ?? null),
        findMany: jest.fn().mockResolvedValue(queryRows),
      },
      timesheets: { findMany: jest.fn().mockResolvedValue(queryRows) },
      organizationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]), onConflictDoNothing: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { builder: txBuilder, where: txWhere } = makeBuilder([]);
      const tx = {
        select: jest.fn().mockReturnValue(txBuilder),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99 }]) }) }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
      };
      void txWhere;
      return fn(tx);
    }),
  } as unknown as Db;

  return { db, where };
}

const mockCache = {
  cachedVersioned: jest.fn().mockImplementation((_ns: string, _k: string, fn: () => unknown) => fn()),
  invalidateNamespace: jest.fn(),
};
const mockAudit = { record: jest.fn(), log: jest.fn() };
const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue({ permissions: [] }),
  scopeFor: jest.fn().mockResolvedValue("none"),
};

describe("FxService — cross-tenant isolation", () => {
  // Rates live on the org's book (gl_fx_rates), so the tenant boundary is the
  // book lookup: the real BooksService runs against the double, and the rate
  // read only ever sees the id of the book that lookup returned.
  function makeFx() {
    return {
      rateFor: jest.fn().mockResolvedValue({ id: "rate-1", rate: "1.2", rateDate: "2025-01-01" }),
    } as unknown as AccountingFxService & { rateFor: jest.Mock };
  }

  it("returns empty map for attacker org (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const fx = makeFx();
    const svc = new FxService(new BooksService(db, {} as PackRegistry), fx);
    const result = await svc.getLatestRates(ATTACKER_ORG, ["USD"], "EUR");
    expect(result.size).toBe(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    expect(fx.rateFor).not.toHaveBeenCalled();
  });

  it("returns rates for the owning org (control — same-tenant)", async () => {
    const book = { id: "book-owner", orgId: OWNER_ORG, isDefault: true, baseCurrency: "EUR" };
    const { db, where } = makeDb([book]);
    const fx = makeFx();
    const svc = new FxService(new BooksService(db, {} as PackRegistry), fx);
    const result = await svc.getLatestRates(OWNER_ORG, ["USD"], "EUR");
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER_ORG);
    expect(fx.rateFor).toHaveBeenCalledWith("book-owner", "USD", "EUR", expect.any(String));
    expect(result.size).toBe(1);
    expect(result.get("USD")?.rate).toBeCloseTo(1.2);
  });
});

describe("EntriesPeriodService — cross-tenant isolation", () => {
  it("loadSettings: WHERE includes attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new EntriesPeriodService(db);
    await svc.loadSettings(ATTACKER_ORG);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("loadSettings: returns undefined for own org with no settings (control)", async () => {
    const { db } = makeDb([]);
    const svc = new EntriesPeriodService(db);
    const result = await svc.loadSettings(OWNER_ORG);
    expect(result).toBeUndefined();
  });
});

describe("ExceptionsDetectorService — cross-tenant isolation", () => {
  it("detectForOrg: WHERE includes attacker orgId in first query (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new ExceptionsDetectorService(db);
    await svc.detectForOrg(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("detectForOrg: completes without error for own org (control — same tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new ExceptionsDetectorService(db);
    await expect(svc.detectForOrg(OWNER_ORG)).resolves.not.toThrow();
  });
});

describe("TimesheetsAuditService — cross-tenant isolation", () => {
  it("listAuditEvents: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TimesheetsAuditService(db);
    await svc.listAuditEvents(ATTACKER_ORG, { limit: 50 });
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("listAuditEvents: returns empty data for own org with no events (control)", async () => {
    const { db } = makeDb([]);
    const svc = new TimesheetsAuditService(db);
    const result = await svc.listAuditEvents(OWNER_ORG, { limit: 50 });
    expect(result.data).toHaveLength(0);
  });
});

describe("BudgetsService — cross-tenant isolation", () => {
  it("list: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new BudgetsService(db, mockAudit as never);
    await svc.list(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("list: returns empty array for own org with no budgets (control)", async () => {
    const { db } = makeDb([]);
    const svc = new BudgetsService(db, mockAudit as never);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(0);
  });
});

describe("RatesService — cross-tenant isolation", () => {
  it("listRates: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new RatesService(db, mockCache as never, mockAudit as never);
    const u = { orgId: ATTACKER_ORG, userId: "user-x" } as never;
    await svc.listRates(u);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("listRates: returns empty rates for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new RatesService(db, mockCache as never, mockAudit as never);
    const u = { orgId: OWNER_ORG, userId: "user-y" } as never;
    const result = await svc.listRates(u);
    expect(result.rates).toHaveLength(0);
  });
});

describe("RateResolverService — cross-tenant isolation", () => {
  it("getDefaultCurrency: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new RateResolverService(db, mockCache as never);
    await svc.getDefaultCurrency(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getDefaultCurrency: returns default value for own org (control)", async () => {
    const { db } = makeDb([]);
    const svc = new RateResolverService(db, mockCache as never);
    const result = await svc.getDefaultCurrency(OWNER_ORG);
    expect(typeof result).toBe("string");
  });
});

describe("EntriesReadService — cross-tenant isolation", () => {
  it("listEntries: a scope that resolves to none denies before the database is ever queried", async () => {
    const { db, where } = makeDb([]);
    const svc = new EntriesReadService(db, mockAccess as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(result.data).toHaveLength(0);
    expect(where).not.toHaveBeenCalled();
  });

  it("listEntries: returns empty for own org with no entries (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new EntriesReadService(db, mockAccess as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(result.data).toHaveLength(0);
  });
});

describe("TeamService — cross-tenant isolation", () => {
  it("getWeekSummary: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TeamService(db, mockAccess as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    await svc.getWeekSummary(u, { startDate: "2025-01-06", endDate: "2025-01-12", userIds: ["user-1"] } as never);
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getWeekSummary: completes for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new TeamService(db, mockAccess as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    await expect(svc.getWeekSummary(u, { startDate: "2025-01-06", endDate: "2025-01-12", userIds: ["user-1"] } as never)).resolves.toBeDefined();
  });
});

describe("EntriesService — cross-tenant isolation", () => {
  it("delegates listEntries to reader with caller's orgId (cross-tenant isolation contract)", async () => {
    const mockReader = { listEntries: jest.fn().mockResolvedValue([]) };
    const svc = new EntriesService({} as Db, mockAccess as never, mockAudit as never, mockReader as never, {} as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker" } as never;
    await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(mockReader.listEntries).toHaveBeenCalledWith(u, expect.anything());
  });

  it("returns empty for own org (control — same-tenant delegation)", async () => {
    const mockReader = { listEntries: jest.fn().mockResolvedValue([]) };
    const svc = new EntriesService({} as Db, mockAccess as never, mockAudit as never, mockReader as never, {} as never);
    const u = { orgId: OWNER_ORG, userId: "u" } as never;
    const result = await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(result).toHaveLength(0);
  });
});

describe("TimesheetExceptionsService — cross-tenant isolation", () => {
  it("listExceptions: a scope that resolves to none denies before the database is ever queried", async () => {
    const { db, where } = makeDb([]);
    const svc = new TimesheetExceptionsService(db, mockAccess as never, mockAudit as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.listExceptions(u, {} as never);
    expect(result.data).toHaveLength(0);
    expect(where).not.toHaveBeenCalled();
  });

  it("listExceptions: returns empty for own org with no exceptions (control)", async () => {
    const { db } = makeDb([]);
    const svc = new TimesheetExceptionsService(db, mockAccess as never, mockAudit as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [], principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.listExceptions(u, {} as never);
    expect(result.data).toHaveLength(0);
  });
});

describe("TimerService — cross-tenant isolation", () => {
  it("getActive: WHERE contains attacker orgId (deny — no timer returned for other org)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TimerService(db, {} as never, mockAudit as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.getActive(u);
    expect(result).toBeNull();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getActive: returns null for own org with no active timer (control)", async () => {
    const { db } = makeDb([]);
    const svc = new TimerService(db, {} as never, mockAudit as never);
    const u = { orgId: OWNER_ORG, userId: "u", principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.getActive(u);
    expect(result).toBeNull();
  });
});

describe("PayrollSettingsService — cross-tenant isolation", () => {
  const fakeSettings = { orgId: ATTACKER_ORG, defaultCurrency: "USD", roundingMode: "NONE", overtimeEnabled: false, overtimeThresholdHours: "40", overtimeRate: "1.5", breakDeductionEnabled: false, breakDurationMinutes: 0, requireApproval: false, approvalDeadlineDays: 7, lockAfterApproval: false, exportFormat: "CSV", createdAt: new Date(), updatedAt: new Date() };

  it("getSettings: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([fakeSettings]);
    const svc = new PayrollSettingsService(db, mockCache as never, mockAudit as never);
    await svc.getSettings(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getSettings: returns settings for own org (control — same-tenant)", async () => {
    const { db } = makeDb([{ ...fakeSettings, orgId: OWNER_ORG }]);
    const svc = new PayrollSettingsService(db, mockCache as never, mockAudit as never);
    const result = await svc.getSettings(OWNER_ORG);
    expect(result).toBeDefined();
  });
});

describe("PayrollSummaryService — cross-tenant isolation", () => {
  it("getPeriodSummary: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PayrollSummaryService(db, mockCache as never);
    const query = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    await svc.getPeriodSummary(ScopedRead.of(ATTACKER_ORG, "actor-x", "all"), query);
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getPeriodSummary: runs for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new PayrollSummaryService(db, mockCache as never);
    const query = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    await expect(svc.getPeriodSummary(ScopedRead.of(OWNER_ORG, "actor-y", "all"), query)).resolves.toBeDefined();
  });
});

describe("PayrollExportService — cross-tenant isolation", () => {
  const fakeExportRow = { id: 1, orgId: ATTACKER_ORG, exportType: "PAYROLL", status: "COMPLETED", dateRangeStart: "2025-01-01", dateRangeEnd: "2025-01-31", format: "CSV", filters: {}, snapshot: [], entryCount: 1, totalHours: "8", note: null, ackStatus: "PENDING", ackAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date() };
  const makeTxImpl = (orgId: string) => async (fn: (tx: unknown) => Promise<unknown>) => {
    const fakeEntry = { id: 1, orgId, userId: "user-1", hours: "8", isBillable: true, date: "2025-01-06", voidedAt: null };
    const { builder: txBuilder } = makeBuilder([fakeEntry]);
    const tx = {
      select: jest.fn().mockReturnValue(txBuilder),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([fakeExportRow]), onConflictDoNothing: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    };
    return fn(tx);
  };

  it("runExport: WHERE contains attacker orgId in settings query (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    (db as unknown as { transaction: jest.Mock }).transaction.mockImplementation(makeTxImpl(ATTACKER_ORG));
    const svc = new PayrollExportService(db, mockCache as never, mockAudit as never, {} as never);
    const input = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    await expect(svc.runExport(ATTACKER_ORG, "user-x", input)).resolves.toBeDefined();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("runExport: runs for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    (db as unknown as { transaction: jest.Mock }).transaction.mockImplementation(makeTxImpl(OWNER_ORG));
    const svc = new PayrollExportService(db, mockCache as never, mockAudit as never, {} as never);
    const input = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    await expect(svc.runExport(OWNER_ORG, "user-y", input)).resolves.toBeDefined();
  });
});
