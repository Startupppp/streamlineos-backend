import type { Db } from "../../../../db/drizzle.module";
import { FxService } from "../fx.service";
import { EntriesPeriodService } from "../entries-period.service";
import { ExceptionsDetectorService } from "../exceptions-detector.service";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import { BudgetsService } from "../budgets.service";
import { RatesService } from "../rates.service";
import { RateResolverService } from "../rate-resolver.service";
import { EntriesReadService } from "../entries-read.service";
import { TeamService } from "../team.service";
import { EntriesService } from "../entries.service";
import { ExceptionsService } from "../exceptions.service";
import { TimerService } from "../timer.service";
import { PayrollExportService } from "../../payroll/payroll-export.service";
import { PayrollSettingsService } from "../../payroll/payroll-settings.service";
import { PayrollSummaryService } from "../../payroll/payroll-summary.service";

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
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    offset: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
    for: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown[]) => void) => Promise.resolve(rows).then(resolve),
    ),
  };
  for (const key of ["from", "where", "limit", "offset", "orderBy", "leftJoin", "innerJoin", "groupBy", "for"]) {
    (builder[key] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where: where as jest.Mock };
}

function makeInsertBuilder(rows: unknown[] = [{ id: 1 }]) {
  const ib: Record<string, unknown> = {
    values: jest.fn(),
    onConflictDoNothing: jest.fn(),
    onConflictDoUpdate: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
    ),
  };
  (ib.values as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoNothing as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoUpdate as jest.Mock).mockReturnValue(ib);
  return ib;
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
    insert: jest.fn().mockReturnValue(makeInsertBuilder()),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { builder: txBuilder } = makeBuilder([]);
      const tx = {
        select: jest.fn().mockReturnValue(txBuilder),
        insert: jest.fn().mockReturnValue(makeInsertBuilder([{ id: 99 }])),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
      };
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
  scopeFor: jest.fn().mockResolvedValue("all"),
};

describe("FxService — cross-tenant isolation", () => {
  it("returns empty map for attacker org (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new FxService(db);
    const result = await svc.getLatestRates(ATTACKER_ORG, ["USD"], "EUR");
    expect(result.size).toBe(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns rates for the owning org (control — same-tenant)", async () => {
    const row = { fromCurrency: "USD", rate: "1.2", asOfDate: "2025-01-01" };
    const { db } = makeDb([row]);
    const svc = new FxService(db);
    const result = await svc.getLatestRates(OWNER_ORG, ["USD"], "EUR");
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
    await svc.listAuditEvents(ATTACKER_ORG, {});
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("listAuditEvents: returns empty data for own org with no events (control)", async () => {
    const { db } = makeDb([]);
    const svc = new TimesheetsAuditService(db);
    const result = await svc.listAuditEvents(OWNER_ORG, {});
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
  it("listEntries: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new EntriesReadService(db, mockAccess as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [] } as never;
    const result = await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(result).toHaveLength(0);
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("listEntries: returns empty for own org with no entries (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new EntriesReadService(db, mockAccess as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [] } as never;
    const result = await svc.listEntries(u, { page: 1, limit: 25 } as never);
    expect(result).toHaveLength(0);
  });
});

describe("TeamService — cross-tenant isolation", () => {
  it("getWeekSummary: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TeamService(db, mockAccess as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [] } as never;
    const q = { userIds: ["user-a"], startDate: "2025-01-06", endDate: "2025-01-12" } as never;
    await svc.getWeekSummary(u, q);
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getWeekSummary: completes for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new TeamService(db, mockAccess as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [] } as never;
    const q = { userIds: ["user-b"], startDate: "2025-01-06", endDate: "2025-01-12" } as never;
    await expect(svc.getWeekSummary(u, q)).resolves.toBeDefined();
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

describe("ExceptionsService — cross-tenant isolation", () => {
  it("listExceptions: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new ExceptionsService(db, mockAccess as never, mockAudit as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker", isOrgOwner: false, permissions: [] } as never;
    const result = await svc.listExceptions(u, {} as never);
    expect(result).toHaveLength(0);
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("listExceptions: returns empty for own org with no exceptions (control)", async () => {
    const { db } = makeDb([]);
    const svc = new ExceptionsService(db, mockAccess as never, mockAudit as never);
    const u = { orgId: OWNER_ORG, userId: "u", isOrgOwner: false, permissions: [] } as never;
    const result = await svc.listExceptions(u, {} as never);
    expect(result).toHaveLength(0);
  });
});

describe("TimerService — cross-tenant isolation", () => {
  it("getActive: WHERE contains attacker orgId (deny — no timer returned for other org)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TimerService(db, {} as never, mockAudit as never);
    const u = { orgId: ATTACKER_ORG, userId: "attacker" } as never;
    const result = await svc.getActive(u);
    expect(result).toBeNull();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getActive: returns null for own org with no active timer (control)", async () => {
    const { db } = makeDb([]);
    const svc = new TimerService(db, {} as never, mockAudit as never);
    const u = { orgId: OWNER_ORG, userId: "u" } as never;
    const result = await svc.getActive(u);
    expect(result).toBeNull();
  });
});

describe("PayrollSettingsService — cross-tenant isolation", () => {
  it("getSettings: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const settingsRow = { orgId: ATTACKER_ORG, payPeriod: "MONTHLY", overtimeDailyHours: "8", overtimeWeeklyHours: "40", includeNonBillable: true, payrollMapping: null };
    const { db, where } = makeDb([settingsRow]);
    const svc = new PayrollSettingsService(db, mockCache as never, mockAudit as never);
    await svc.getSettings(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getSettings: returns settings for own org (control — same-tenant)", async () => {
    const settingsRow = { orgId: OWNER_ORG, payPeriod: "MONTHLY", overtimeDailyHours: "8", overtimeWeeklyHours: "40", includeNonBillable: true, payrollMapping: null };
    const { db } = makeDb([settingsRow]);
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
    await svc.getPeriodSummary(ATTACKER_ORG, query, "all", "actor-x");
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getPeriodSummary: runs for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new PayrollSummaryService(db, mockCache as never);
    const query = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    await expect(svc.getPeriodSummary(OWNER_ORG, query, "all", "actor-y")).resolves.toBeDefined();
  });
});

describe("PayrollExportService — cross-tenant isolation", () => {
  it("runExport: WHERE contains attacker orgId in settings query (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    (db as unknown as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const { builder: txBuilder } = makeBuilder([]);
        const tx = {
          select: jest.fn().mockReturnValue(txBuilder),
          insert: jest.fn().mockReturnValue(makeInsertBuilder([{ id: 1 }])),
          update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        };
        return fn(tx);
      }
    );
    const svc = new PayrollExportService(db, mockCache as never, mockAudit as never);
    const input = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    try { await svc.runExport(ATTACKER_ORG, "user-x", input); } catch {}
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("runExport: settings query uses own orgId (control — same-tenant)", async () => {
    const { db, where } = makeDb([]);
    (db as unknown as { transaction: jest.Mock }).transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const { builder: txBuilder } = makeBuilder([]);
        const tx = {
          select: jest.fn().mockReturnValue(txBuilder),
          insert: jest.fn().mockReturnValue(makeInsertBuilder([{ id: 1 }])),
          update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        };
        return fn(tx);
      }
    );
    const svc = new PayrollExportService(db, mockCache as never, mockAudit as never);
    const input = { start: "2025-01-01", end: "2025-01-31", includeExported: false } as never;
    try { await svc.runExport(OWNER_ORG, "user-y", input); } catch {}
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(OWNER_ORG);
  });
});
