import { ModuleChecklistService } from "./module-checklist.service";
import type { OnboardingAnalyticsService } from "./onboarding-analytics.service";
import type { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";

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
    );

    // ensureChecklistsForModules itself (idempotent insert-if-missing) is pre-existing,
    // unchanged behavior — this spec only verifies the NEW call sites in listChecklists/
    // getChecklist invoke it correctly, so it's stubbed rather than exercised end-to-end.
    ensureSpy = jest.spyOn(service, "ensureChecklistsForModules").mockResolvedValue(undefined);
  });

  it("listChecklists: calls ensureChecklistsForModules with every visible module key before querying", async () => {
    await service.listChecklists(ORG_ID, ["crm", "hr"], true);
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm", "hr"]);
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });

  it("listChecklists: still returns results correctly after the self-heal call (no regression)", async () => {
    findMany.mockResolvedValue([{ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [] }]);
    const result = await service.listChecklists(ORG_ID, ["crm"], false);
    expect(result).toHaveLength(1);
    expect(result[0].moduleKey).toBe("crm");
  });

  it("getChecklist: calls ensureChecklistsForModules scoped to just the requested module key", async () => {
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [] });
    await service.getChecklist(ORG_ID, "crm", ["crm", "hr"]);
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });

  it("getChecklist: an org that predates this feature (row seeded lazily by ensure) reads it back in the same call", async () => {
    // Simulates the real self-heal path: the DB starts with no row, but
    // ensureChecklistsForModules (run unconditionally before the single findFirst below)
    // is what would have inserted it — so by the time findFirst runs, the row exists.
    findFirst.mockResolvedValue({ id: 2, orgId: ORG_ID, moduleKey: "crm", items: [] });
    const result = await service.getChecklist(ORG_ID, "crm", ["crm"]);
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
    expect(result.id).toBe(2);
  });

  it("getChecklist: still throws NotFoundException if no row exists even after the self-heal call runs", async () => {
    findFirst.mockResolvedValue(undefined);
    await expect(service.getChecklist(ORG_ID, "crm", ["crm"])).rejects.toThrow(
      "Module setup checklist not found: crm",
    );
    expect(ensureSpy).toHaveBeenCalledWith(ORG_ID, ["crm"]);
  });

  it("getChecklist: still 404s for a module key the caller can't see, without calling ensure", async () => {
    await expect(service.getChecklist(ORG_ID, "payments", ["crm"])).rejects.toThrow(
      "Module setup checklist not found: payments",
    );
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});

describe("ModuleChecklistService — syncItemMetadataFromSeed (fixes stale actionHref on orgs provisioned before a seed edit)", () => {
  let service: ModuleChecklistService;
  let findFirst: jest.Mock;
  let updateSetCalls: Record<string, unknown>[];
  let mockDb: {
    query: {
      moduleSetupChecklists: { findFirst: jest.Mock };
      moduleSetupChecklistItems: { findMany: jest.Mock };
    };
    update: jest.Mock;
  };

  beforeEach(() => {
    updateSetCalls = [];
    findFirst = jest.fn();
    mockDb = {
      query: {
        moduleSetupChecklists: { findFirst },
        // Only exercised by the HR path (reconcileAndReload -> recomputeProgress); the
        // exact contents don't matter for these metadata-sync assertions.
        moduleSetupChecklistItems: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          updateSetCalls.push(values);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    service = new ModuleChecklistService(
      mockDb as never,
      { track: jest.fn() } as unknown as OnboardingAnalyticsService,
      { reconcile: jest.fn().mockResolvedValue(false) } as unknown as HrChecklistReconciliationService,
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

    const result = await service.getChecklist(ORG_ID, "crm", ["crm"]);

    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toMatchObject({ actionHref: "/crm/deals" });
    expect(result.items[0].actionHref).toBe("/crm/deals");
  });

  it("does not write anything when the item's metadata already matches the current seed", async () => {
    const upToDateItem = baseItem({ itemKey: "create_pipeline", actionHref: "/crm/deals" });
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [upToDateItem] });

    await service.getChecklist(ORG_ID, "crm", ["crm"]);

    expect(updateSetCalls).toHaveLength(0);
  });

  it("ignores item rows whose itemKey no longer has a matching seed entry (nothing to sync against)", async () => {
    const orphanedItem = baseItem({ itemKey: "some_removed_step", actionHref: "/crm/whatever" });
    findFirst.mockResolvedValue({ id: 1, orgId: ORG_ID, moduleKey: "crm", items: [orphanedItem] });

    await service.getChecklist(ORG_ID, "crm", ["crm"]);

    expect(updateSetCalls).toHaveLength(0);
  });

  it("always reloads after reconciling HR, even when the reconciliation service itself reports no status change (otherwise a metadata-only sync would be silently discarded)", async () => {
    const staleItem = baseItem({ itemKey: "org_profile", actionHref: "/old/org/profile/route", status: "done" });
    findFirst
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "hr", items: [staleItem] })
      .mockResolvedValueOnce({ id: 1, orgId: ORG_ID, moduleKey: "hr", items: [{ ...staleItem, actionHref: "/settings/organization" }] });

    const result = await service.getChecklist(ORG_ID, "hr", ["hr"]);

    expect(updateSetCalls.some((c) => c.actionHref === "/settings/organization")).toBe(true);
    expect(result.items[0].actionHref).toBe("/settings/organization");
  });
});
