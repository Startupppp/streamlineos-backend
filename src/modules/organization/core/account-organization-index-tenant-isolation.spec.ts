import { AccountOrganizationIndexService } from "./account-organization-index.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(), for: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy", "leftJoin", "innerJoin", "for"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

jest.mock("../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn((_db: unknown, _userId: string, fn: (tx: unknown) => unknown) => fn(_db)),
}));

jest.mock("../../../common/region/region-registry", () => ({
  hasRegionRegistry: jest.fn().mockReturnValue(false),
  getRegionRegistry: jest.fn(),
}));

describe("AccountOrganizationIndexService — cross-tenant isolation", () => {
  const USER_A = "user-a";
  const USER_B = "user-b";
  const ROW = { orgId: "org-1", organizationName: "Org1", organizationSlug: "org1", membershipRole: "MEMBER", joinedAt: new Date() };

  it("listForUser returns only orgs belonging to the requesting user (tenant isolation)", async () => {
    const { builder, where } = makeChain([]);
    const db = { select: jest.fn().mockReturnValue(builder), query: { accountOrganizationIndex: { findMany: jest.fn().mockResolvedValue([]) } } } as unknown as Db;
    const svc = new AccountOrganizationIndexService(db);
    const result = await svc.listForUser(USER_A);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(USER_A);
    expect(vals).not.toContain(USER_B);
  });

  it("listForUser returns rows for the requesting user (control)", async () => {
    const { builder } = makeChain([ROW]);
    const db = { select: jest.fn().mockReturnValue(builder), query: { accountOrganizationIndex: { findMany: jest.fn().mockResolvedValue([]) } } } as unknown as Db;
    const svc = new AccountOrganizationIndexService(db);
    const result = await svc.listForUser(USER_A);
    expect(result).toHaveLength(1);
  });
});
