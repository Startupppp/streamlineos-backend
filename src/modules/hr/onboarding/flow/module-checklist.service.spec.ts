import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ModuleChecklistService } from "./module-checklist.service";
import type { OnboardingAnalyticsService } from "./onboarding-analytics.service";
import type { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";

const dialect = new PgDialect();
const ORG_ID = "org-1";

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 99,
    orgId: ORG_ID,
    checklistId: 1,
    itemKey: "create_pipeline",
    title: "Create first pipeline",
    description: null,
    actionHref: "/crm/deals",
    status: "todo",
    required: true,
    sortOrder: 1,
    completedAt: null,
    skippedAt: null,
    ...overrides,
  };
}

describe("ModuleChecklistService — lazy checklist self-heal on read", () => {
  let service: ModuleChecklistService;
  let findMany: jest.Mock;
  let findFirst: jest.Mock;
  let updateSetCalls: Record<string, unknown>[];
  let updateMock: jest.Mock;
  let mockDb: {
    query: {
      moduleSetupChecklists: { findMany: jest.Mock; findFirst: jest.Mock };
    };
    update: jest.Mock;
  };
  let ensureSpy: jest.SpyInstance;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    findFirst = jest.fn().mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [] });
    updateSetCalls = [];
    updateMock = jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    }));
    mockDb = {
      query: {
        moduleSetupChecklists: { findMany, findFirst },
      },
      update: updateMock,
    };

    service = new ModuleChecklistService(
      mockDb as never,
      { track: jest.fn() } as unknown as OnboardingAnalyticsService,
      { reconcile: jest.fn() } as unknown as HrChecklistReconciliationService,
      { listModules: jest.fn().mockResolvedValue([
        { moduleKey: "crm", enabled: true },
        { moduleKey: "hr", enabled: true },
      ]) } as never,
    );

    ensureSpy = jest.spyOn(service, "ensureChecklistsForModules").mockResolvedValue(undefined);
  });

  it("listChecklists: calls ensureChecklistsForModules with every visible module key before querying", async () => {
    await service.listChecklists(ORG_ID, new Set(["crm", "hr"]));
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm", "hr"]);
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });

  it("listChecklists: still returns results correctly after the self-heal call (no regression)", async () => {
    findMany.mockResolvedValue([{ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [] }]);
    const result = await service.listChecklists(ORG_ID, new Set(["crm"]));
    expect(result).toHaveLength(1);
    expect(result[0].moduleKey).toBe("crm");
  });

  it("getChecklist: calls ensureChecklistsForModules scoped to just the requested module key", async () => {
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [] });
    await service.getChecklist(ORG_ID, "crm");
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });

  it("getChecklist: an org that predates this feature (row seeded lazily by ensure) reads it back in the same call", async () => {
    // Simulates the real self-heal path: the DB starts with no row, but
    // ensureChecklistsForModules (run unconditionally before the single findFirst below)
    // is what would have inserted it — so by the time findFirst runs, the row exists.
    findFirst.mockResolvedValue({ id: 2, orgId: ORG_ID, moduleKey: "crm", items: [] });
    const result = await service.getChecklist(ORG_ID, "crm");
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
    expect(result.id).toBe(2);
  });

  it("getChecklist: still throws NotFoundException if no row exists even after the self-heal call runs", async () => {
    findFirst.mockResolvedValue(undefined);
    await expect(service.getChecklist(ORG_ID, "crm")).rejects.toThrow(
      "Module setup checklist not found: crm",
    );
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
  });

  it("getChecklist: still 404s for a module key the caller can't see, without calling ensure", async () => {
    await expect(service.getChecklist(ORG_ID, "payments")).rejects.toThrow(
      "Module setup checklist not found: payments",
    );
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});

describe("ModuleChecklistService — syncItemMetadataFromSeed (fixes stale actionHref on orgs provisioned before a seed edit)", () => {
  let service: ModuleChecklistService;
  let findFirst: jest.Mock;
  // The reconciliation used to issue one `db.update(...).set(...)` per stale item and these
  // tests asserted on the `set` payload. It is one `UPDATE ... FROM (VALUES ...)` now, so the
  // mechanism assertion is replaced by the bound parameters of the statement actually issued —
  // a stronger check, because it also proves there is exactly ONE statement and that org_id is
  // bound. `update` is kept on the double deliberately: a regression to the per-item shape
  // leaves `executed` empty and fails every assertion below.
  let executed: SQL[];
  let mockDb: {
    query: {
      moduleSetupChecklists: { findFirst: jest.Mock };
      moduleSetupChecklistItems: { findMany: jest.Mock };
    };
    update: jest.Mock;
    execute: jest.Mock;
  };

  const paramsOf = () => executed.flatMap((statement) => dialect.sqlToQuery(statement).params);

  beforeEach(() => {
    executed = [];
    findFirst = jest.fn();
    mockDb = {
      query: {
        moduleSetupChecklists: { findFirst },
        // Only exercised by the HR path (reconcileAndReload -> recomputeProgress); the
        // exact contents don't matter for these metadata-sync assertions.
        moduleSetupChecklistItems: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
      })),
      execute: jest.fn((statement: SQL) => {
        executed.push(statement);
        return Promise.resolve([]);
      }),
    };
    service = new ModuleChecklistService(
      mockDb as never,
      { track: jest.fn() } as unknown as OnboardingAnalyticsService,
      { reconcile: jest.fn().mockResolvedValue(false) } as unknown as HrChecklistReconciliationService,
      { listModules: jest.fn().mockResolvedValue([
        { moduleKey: "crm", enabled: true },
        { moduleKey: "hr", enabled: true },
      ]) } as never,
    );
    jest.spyOn(service, "ensureChecklistsForModules").mockResolvedValue(undefined);
  });

  it("regression: an item row with a stale actionHref from before a seed fix (e.g. a route that no longer exists) gets corrected on read", async () => {
    // Reproduces exactly what the screenshot showed: an org whose checklist row was created
    // before the /hr/departments -> /hr/org?tab=departments seed fix still had the old,
    // now-404ing actionHref baked into its item row.
    const staleItem = baseItem({ itemKey: "create_pipeline", actionHref: "/crm/old-deals-route" });
    findFirst
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [staleItem] })
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [{ ...staleItem, actionHref: "/crm/deals" }] });

    const result = await service.getChecklist(ORG_ID, "crm");

    expect(executed).toHaveLength(1);
    expect(paramsOf()).toEqual(expect.arrayContaining(["/crm/deals", ORG_ID]));
    expect(result.items[0].actionHref).toBe("/crm/deals");
  });

  it("does not write anything when the item's metadata already matches the current seed", async () => {
    const upToDateItem = baseItem({ itemKey: "create_pipeline", actionHref: "/crm/deals" });
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [upToDateItem] });

    await service.getChecklist(ORG_ID, "crm");

    expect(executed).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("ignores item rows whose itemKey no longer has a matching seed entry (nothing to sync against)", async () => {
    const orphanedItem = baseItem({ itemKey: "some_removed_step", actionHref: "/crm/whatever" });
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [orphanedItem] });

    await service.getChecklist(ORG_ID, "crm");

    expect(executed).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("always reloads after reconciling HR, even when the reconciliation service itself reports no status change (otherwise a metadata-only sync would be silently discarded)", async () => {
    const staleItem = baseItem({ itemKey: "org_profile", actionHref: "/old/org/profile/route", status: "done" });
    findFirst
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "hr", items: [staleItem] })
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "hr", items: [{ ...staleItem, actionHref: "/settings/organization" }] });

    const result = await service.getChecklist(ORG_ID, "hr");

    expect(paramsOf()).toContain("/settings/organization");
    expect(result.items[0].actionHref).toBe("/settings/organization");
  });
});
