import { WorkspaceOnboardingService } from "./workspace-onboarding.service";
import type { Db } from "../../../db/drizzle.module";

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
    const checklists = { ensureChecklistsForModules: jest.fn().mockResolvedValue(undefined) };
    const hierarchyCache = { invalidateOrg: jest.fn().mockResolvedValue(undefined), invalidateAfterMutation: jest.fn().mockResolvedValue(undefined) };
    const svc = new WorkspaceOnboardingService(db, checklists as never, hierarchyCache as never);
    return { svc, where };
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
});
