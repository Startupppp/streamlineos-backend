import { WorkspaceOnboardingService } from "./workspace-onboarding.service";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";

// The real class, so the double cannot grow a method the service does not have.
function buildHierarchyCache(): OrgHierarchyCacheService {
  const cache = {
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
  const hierarchyCache = new OrgHierarchyCacheService(cache);
  jest.spyOn(hierarchyCache, "invalidateAfterMutation").mockResolvedValue(undefined);
  return hierarchyCache;
}

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db)),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("WorkspaceOnboardingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService() {
    const limitFn = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit: limitFn });
    const from = jest.fn().mockReturnValue({ where });
    const selectThenBuilder: Record<string, unknown> = {
      from, where,
      limit: limitFn,
      then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve([]).then(fn, r); },
      catch(fn: (e: unknown) => unknown) { return Promise.resolve([]).catch(fn); },
      finally(fn: () => void) { return Promise.resolve([]).finally(fn); },
    };
    from.mockReturnValue(selectThenBuilder);
    where.mockReturnValue(selectThenBuilder);
    limitFn.mockReturnValue(selectThenBuilder);
    const insertReturning = jest.fn().mockResolvedValue([{ id: "new-unit-id" }]);
    const insertValues = jest.fn().mockReturnValue({ returning: insertReturning });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;
    const hierarchyCache = buildHierarchyCache();
    const svc = new WorkspaceOnboardingService(db, hierarchyCache);
    return { svc, where, hierarchyCache };
  }

  function makeServiceAllExisting() {
    const orgNameResult = [{ name: "Acme Corp" }];
    const buResult = [{ id: "existing-bu" }];
    const branchResult = [{ id: "existing-branch" }];
    const deptResult = [
      { id: "d-engi", code: "ENGI" },
      { id: "d-prod", code: "PROD" },
      { id: "d-oper", code: "OPER" },
      { id: "d-hr",   code: "HR"   },
    ];
    const teamResult = [
      { id: "t-engit", code: "ENGIT" },
      { id: "t-prodt", code: "PRODT" },
      { id: "t-opert", code: "OPERT" },
      { id: "t-hrt",   code: "HRT"   },
    ];
    const RESULTS = [orgNameResult, buResult, branchResult, deptResult, teamResult];
    let callIdx = 0;

    const makeChain = () => {
      const result = RESULTS[callIdx++] ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = jest.fn().mockReturnValue(chain);
      chain.where = jest.fn().mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue(result);
      (chain as Record<string, unknown>).then = (
        fn: (v: unknown) => unknown,
        r?: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(fn, r);
      (chain as Record<string, unknown>).catch = (fn: (e: unknown) => unknown) =>
        Promise.resolve(result).catch(fn);
      (chain as Record<string, unknown>).finally = (fn: () => void) =>
        Promise.resolve(result).finally(fn);
      return chain;
    };

    const insert = jest.fn();
    const db = {
      select: jest.fn().mockImplementation(makeChain),
      insert,
    } as unknown as Db;
    const hierarchyCache = buildHierarchyCache();
    const svc = new WorkspaceOnboardingService(db, hierarchyCache);
    return { svc, insert, hierarchyCache };
  }

  it("generateWorkspace scopes org lookup to the given orgId (cross-tenant isolation)", async () => {
    const { svc, where } = makeService();
    await svc.generateWorkspace(ATTACKER, "it-services");
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("generateWorkspace scopes org lookup to the owning org (control)", async () => {
    const { svc, where } = makeService();
    await svc.generateWorkspace(OWNER, "it-services");
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });

  it("re-run on an org with pre-existing hierarchy fires no inserts and still invalidates cache", async () => {
    const { svc, insert, hierarchyCache } = makeServiceAllExisting();
    const result = await svc.generateWorkspace(OWNER, "it-services");

    expect(insert).not.toHaveBeenCalled();
    expect(result.businessUnits).toBe(0);
    expect(result.branches).toBe(0);
    expect(result.departments).toBe(0);
    expect(result.teams).toBe(0);
    expect(hierarchyCache.invalidateAfterMutation).toHaveBeenCalledWith(OWNER);
  });
});
