import { OrganizationSettingsService } from "./organization-settings.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("OrganizationSettingsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ORG_ROW = { id: OWNER, name: "My Org", slug: "my-org", settings: {}, mfaEnforced: false, allowedDomains: [] };

  function makeService(orgRow: unknown) {
    const findFirst = jest.fn().mockResolvedValue(orgRow);
    const where = jest.fn();
    const selectBuilder: Record<string, unknown> = {
      from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(),
      then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve([]).then(fn, r); },
      catch(fn: (e: unknown) => unknown) { return Promise.resolve([]).catch(fn); },
      finally(fn: () => void) { return Promise.resolve([]).finally(fn); },
    };
    for (const k of ["from", "where", "limit", "orderBy"]) {
      (selectBuilder[k] as jest.Mock).mockReturnValue(selectBuilder);
    }
    const db = {
      query: { organizations: { findFirst } },
      select: jest.fn().mockReturnValue(selectBuilder),
    } as unknown as Db;
    const audit = { log: jest.fn() };
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
      cachedForOrg: jest.fn((_orgId: string, _key: string, fn: () => Promise<unknown>) => fn()),
    };
    const mfaPolicy = { syncMfaPolicy: jest.fn().mockResolvedValue(undefined), invalidateOrg: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrganizationSettingsService(db, audit as never, cache as never, mfaPolicy as never);
    return { svc, findFirst, where };
  }

  it("getSettings returns null for a different org (cross-tenant isolation)", async () => {
    const { svc, findFirst } = makeService(null);
    const result = await svc.getSettings(ATTACKER);
    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalled();
    const call = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(call?.where);
    expect(vals).toContain(ATTACKER);
  });

  it("getSettings returns data for the owning org (control)", async () => {
    const { svc } = makeService(ORG_ROW);
    const result = await svc.getSettings(OWNER);
    expect(result).not.toBeNull();
  });
});
